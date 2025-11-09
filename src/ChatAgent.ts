import { Ai } from '@cloudflare/ai';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface SearchResult {
    documentId: string;
    content: string;
    score: number;
    metadata: {
        title: string;
        type: string;
        section?: string;
    };
}

interface Env {
    AI: Ai;
    DOCS_VECTORDB: any;
    COMPLIANCE_DOCS: R2Bucket;
    COMPLIANCE_KV: KVNamespace;
}

const SYSTEM_PROMPT = `You are a Data Privacy Compliance Officer. You must ONLY use information from the documents provided below.

ABSOLUTE RULES:
- ONLY cite information that appears in the document text below
- If you see a section number in the document (like "Section 2" or "B.1"), use it
- Quote the exact text from the document
- If the answer is not in the document, say "This information is not in the provided policy"
- DO NOT use any information from your training data
- DO NOT make up section numbers or quotes`;

export class ChatAgent implements DurableObject {
    private env: Env;
    private state: DurableObjectState;
    
    constructor(state: DurableObjectState, env: Env) {
        this.env = env;
        this.state = state;
    }
    
    private async getDocumentContent(docId: string): Promise<string | null> {
        try {
            if (this.env.COMPLIANCE_DOCS) {
                const obj = await this.env.COMPLIANCE_DOCS.get(`${docId}.txt`);
                if (obj) {
                    const content = await obj.text();
                    console.log(`Retrieved from R2 (${docId}):`, content.substring(0, 200));
                    return content;
                }
            }
            if (this.env.COMPLIANCE_KV) {
                const content = await this.env.COMPLIANCE_KV.get(`doc:${docId}:content`);
                console.log(`Retrieved from KV (${docId}):`, content?.substring(0, 200));
                return content;
            }
            return null;
        } catch (e) {
            console.error('Error reading document content:', e);
            return null;
        }
    }

    // Extract most relevant portion of document
    private extractRelevantPortion(content: string, query: string): string {
        // For policies, we want to be generous with context
        // If document is small enough, return it all (increased limit)
        if (content.length <= 8000) {
            console.log('Document is small enough, returning full content:', content.length, 'chars');
            return content;
        }

        console.log('Document is large, extracting relevant portions from', content.length, 'chars');

        const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const lines = content.split('\n');
        
        // Score each line
        const scoredLines = lines.map((line, idx) => {
            const lowerLine = line.toLowerCase();
            let score = 0;
            
            queryWords.forEach(word => {
                if (lowerLine.includes(word)) {
                    score += 10;
                }
            });
            
            // Boost lines with section markers
            if (/section\s+\d+|[A-Z]\.\d+/i.test(line)) {
                score += 5;
            }
            
            return { line, score, idx };
        });
        
        // Find high-scoring regions
        const relevant = scoredLines.filter(l => l.score > 0);
        if (relevant.length === 0) {
            // No matches, return first 6000 chars
            console.log('No keyword matches, returning first 6000 chars');
            return content.substring(0, 6000);
        }
        
        // Get continuous sections around high-scoring lines
        const indices = new Set<number>();
        relevant.forEach(r => {
            // Include 10 lines before and after for more context
            for (let i = Math.max(0, r.idx - 10); i <= Math.min(lines.length - 1, r.idx + 10); i++) {
                indices.add(i);
            }
        });
        
        const sortedIndices = Array.from(indices).sort((a, b) => a - b);
        const chunks: string[] = [];
        let currentChunk: number[] = [];
        
        sortedIndices.forEach((idx, i) => {
            if (i === 0 || idx === sortedIndices[i-1] + 1) {
                currentChunk.push(idx);
            } else {
                chunks.push(currentChunk.map(ci => lines[ci]).join('\n'));
                currentChunk = [idx];
            }
        });
        if (currentChunk.length > 0) {
            chunks.push(currentChunk.map(ci => lines[ci]).join('\n'));
        }
        
        const result = chunks.join('\n...\n').substring(0, 6000);
        console.log('Extracted', result.length, 'chars of relevant content');
        return result;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const message = url.searchParams.get('message');

        if (!message) {
            return new Response('Message parameter is required', { status: 400 });
        }

        try {
            console.log('=== Processing query:', message);
            
            const history: ChatMessage[] = await this.state.storage.get('history') || [];
            const ai = new Ai(this.env.AI);
            
            // Generate embeddings
            const queryEmbedding = await ai.run('@cf/baai/bge-base-en-v1.5', {
                text: [message]
            });

            let validResults: Array<any> = [];

            // Try vector search first
            if (this.env.DOCS_VECTORDB && typeof this.env.DOCS_VECTORDB.query === 'function') {
                try {
                    const searchResults = await this.env.DOCS_VECTORDB.query(queryEmbedding.data[0], {
                        topK: 3, // Get top 3 but we'll deduplicate
                        returnMetadata: true
                    });

                    console.log('Vector search found', searchResults.matches?.length || 0, 'matches');

                    // Deduplicate by content hash to avoid duplicate documents
                    const seenContent = new Set<string>();
                    
                    const relevantContext = await Promise.all(
                        searchResults.matches.map(async (match: any) => {
                            const content = await this.getDocumentContent(match.id);
                            if (!content) {
                                console.log('Could not retrieve content for', match.id);
                                return null;
                            }
                            
                            // Create a simple hash of first 200 chars to detect duplicates
                            const contentHash = content.substring(0, 200);
                            if (seenContent.has(contentHash)) {
                                console.log(`Skipping duplicate document ${match.id}`);
                                return null;
                            }
                            seenContent.add(contentHash);
                            
                            console.log(`Match score for ${match.id}:`, match.score);
                            
                            return {
                                documentId: match.id,
                                content: content,
                                score: match.score,
                                metadata: match.metadata
                            };
                        })
                    );

                    validResults = relevantContext.filter(Boolean);
                    console.log('After deduplication:', validResults.length, 'unique documents');
                } catch (vectorErr) {
                    console.error('Vector search failed:', vectorErr);
                    validResults = [];
                }
            }

            // Fallback to keyword search
            if (!validResults || validResults.length === 0) {
                console.log('Falling back to KV keyword search');
                
                if (this.env.COMPLIANCE_KV) {
                    const listResult = await this.env.COMPLIANCE_KV.list({ prefix: 'doc:' });
                    console.log('Found', listResult.keys?.length || 0, 'documents in KV');
                    
                    const scored: Array<any> = [];
                    const qWords = message.toLowerCase().split(/\s+/).filter(Boolean);

                    for (const keyInfo of listResult.keys || []) {
                        // Skip content keys, only process metadata keys
                        if (keyInfo.name.includes(':content')) continue;
                        
                        try {
                            const metadataStr = await this.env.COMPLIANCE_KV.get(keyInfo.name);
                            if (!metadataStr) continue;
                            
                            const metadata = JSON.parse(metadataStr);
                            const id = keyInfo.name.split(':')[1];
                            if (!id) continue;

                            const contentText = await this.getDocumentContent(id);
                            if (!contentText) {
                                console.log('Could not get content for', id);
                                continue;
                            }

                            console.log(`Checking document ${id} (${metadata.title})`);
                            console.log('Content preview:', contentText.substring(0, 200));

                            let score = 0;
                            const lowerContent = contentText.toLowerCase();
                            for (const w of qWords) {
                                const matches = (lowerContent.match(new RegExp(w, 'g')) || []).length;
                                score += matches;
                            }

                            console.log(`Score for ${id}:`, score);

                            if (score > 0) {
                                scored.push({
                                    documentId: id,
                                    content: contentText,
                                    score: score,
                                    metadata: {
                                        title: metadata.title,
                                        type: metadata.type
                                    }
                                });
                            }
                        } catch (err) {
                            console.error('Error processing document:', err);
                            continue;
                        }
                    }

                    scored.sort((a, b) => b.score - a.score);
                    validResults = scored.slice(0, 2);
                    console.log('Keyword search returned', validResults.length, 'results');
                }
            }

            // Build context string - THIS IS CRITICAL
            let documentContext = '';
            if (validResults.length > 0) {
                console.log('Building context from', validResults.length, 'documents');
                
                for (const doc of validResults) {
                    const relevantPortion = this.extractRelevantPortion(doc.content, message);
                    console.log(`Including ${relevantPortion.length} chars from ${doc.metadata.title}`);
                    
                    documentContext += `
=== POLICY DOCUMENT: ${doc.metadata.title} ===
TYPE: ${doc.metadata.type}

${relevantPortion}

=== END DOCUMENT ===

`;
                }
                
                console.log('Total context length:', documentContext.length);
                console.log('Context preview:', documentContext.substring(0, 500));
            } else {
                console.log('WARNING: No documents found for query');
            }

            // Build messages array - CRITICAL ORDERING
            const aiMessages: ChatMessage[] = [];
            
            // 1. System prompt with embedded document context
            const systemMessage = validResults.length > 0 
                ? `${SYSTEM_PROMPT}

Here are the policy documents you must reference:

${documentContext}

Remember: ONLY use information from the documents above. Quote exact text. Use actual section numbers from the documents.`
                : `${SYSTEM_PROMPT}

NO POLICY DOCUMENTS AVAILABLE. You cannot answer compliance questions without documents.`;

            aiMessages.push({
                role: 'system',
                content: systemMessage,
                timestamp: Date.now()
            });

            console.log('System message length:', systemMessage.length);

            // 2. Add minimal history (just last exchange if any)
            const recentHistory = history.slice(-2);
            if (recentHistory.length > 0) {
                console.log('Including', recentHistory.length, 'history messages');
                aiMessages.push(...recentHistory);
            }

            // 3. User message
            const userMessage: ChatMessage = {
                role: 'user',
                content: message,
                timestamp: Date.now()
            };
            aiMessages.push(userMessage);

            console.log('Total messages to AI:', aiMessages.length);
            console.log('Total prompt size:', JSON.stringify(aiMessages).length, 'chars');

            // Generate response
            const aiResponse = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
                messages: aiMessages,
                temperature: 0.01, // Extremely low for strict adherence
                max_tokens: 1500   // Increased to allow complete answers with quotes
            });

            // Handle response
            let responseText: string;
            if (typeof aiResponse === 'string') {
                responseText = aiResponse;
            } else if (aiResponse instanceof ReadableStream) {
                const reader = aiResponse.getReader();
                const decoder = new TextDecoder();
                let text = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    text += decoder.decode(value);
                }
                responseText = text;
            } else if (aiResponse && typeof aiResponse === 'object' && 'response' in aiResponse) {
                responseText = (aiResponse as any).response;
            } else {
                responseText = JSON.stringify(aiResponse);
            }

            console.log('AI response:', responseText);

            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: responseText,
                timestamp: Date.now()
            };

            // Update history
            history.push(userMessage, assistantMessage);
            const trimmedHistory = history.slice(-10);
            await this.state.storage.put('history', trimmedHistory);

            return new Response(JSON.stringify({
                response: assistantMessage.content,
                context: validResults.map(doc => ({
                    title: doc.metadata.title,
                    type: doc.metadata.type,
                    relevanceScore: doc.score
                })),
                debug: {
                    documentsFound: validResults.length,
                    contextLength: documentContext.length,
                    promptLength: systemMessage.length
                }
            }), {
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            console.error('Chat agent error:', error);
            return new Response(JSON.stringify({ 
                error: 'Failed to process your request',
                details: error instanceof Error ? error.message : 'Unknown error'
            }), { 
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}