import { Hono } from 'hono';
import { Ai } from '@cloudflare/ai';
import { ChatAgent } from './ChatAgent';

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ConversationHistory {
    messages: Message[];
    lastUpdated: number;
}

interface ComplianceDocument {
    id: string;
    title: string;
    content: string;
    type: 'policy' | 'guideline' | 'audit';
    tags: string[];
    createdAt: number;
    updatedAt: number;
}

interface DocumentMetadata {
    id: string;
    title: string;
    type: string;
    tags: string[];
}

interface DocumentSearchResult {
    document: DocumentMetadata;
    relevanceScore: number;
    snippets: string[];
}

interface StorageOperation {
    type: 'r2' | 'kv';
    key: string;
}

export interface Env {
    AI: Ai;
    ASSETS: Fetcher;
    COMPLIANCE_KV: KVNamespace;
    COMPLIANCE_DOCS: R2Bucket;
    DOCS_VECTORDB: any;
    CHAT_AGENT: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Helper function to generate embeddings using Cloudflare AI
async function generateEmbeddings(ai: Ai, text: string): Promise<number[]> {
    const response = await ai.run('@cf/baai/bge-base-en-v1.5', {
        text: [text]
    });
    return response.data[0];
}

// Helper function to extract relevant snippets from document content
function extractRelevantSnippets(content: string, query: string): string[] {
    const sentences = content.split(/[.!?]+/);
    return sentences
        .filter(sentence => 
            sentence.toLowerCase().includes(query.toLowerCase()) ||
            query.toLowerCase().split(' ').some(word => 
                sentence.toLowerCase().includes(word)
            )
        )
        .map(s => s.trim())
        .slice(0, 3);
}

// Helper function to safely read document content
async function getDocumentContent(c: any, docId: string): Promise<string | null> {
    try {
        if (c.env.COMPLIANCE_DOCS) {
            const contentObj = await c.env.COMPLIANCE_DOCS.get(`${docId}.txt`);
            if (contentObj) {
                return await contentObj.text();
            }
        }
        // Fallback to KV
        return await c.env.COMPLIANCE_KV.get(`doc:${docId}:content`);
    } catch (error) {
        console.error(`Error reading document ${docId}:`, error);
        return null;
    }
}

// Admin endpoint to upload compliance documents
app.post('/api/admin/documents', async (c) => {
    try {
        const formData = await c.req.formData();
        
        // Get and validate metadata
        const title = formData.get('title')?.toString().trim() || '';
        const type = formData.get('type')?.toString() as 'policy' | 'guideline' | 'audit';
        const tags = (formData.get('tags')?.toString() || '').split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);

        // Validate required fields
        if (!title || title.length < 3) {
            return c.json({ error: 'Title must be at least 3 characters long' }, 400);
        }
        if (!type || !['policy', 'guideline', 'audit'].includes(type)) {
            return c.json({ error: 'Valid document type is required' }, 400);
        }

        // Handle content from direct input
        let documentContent = '';
        const contentField = formData.get('content');

        if (contentField?.toString().trim()) {
            documentContent = contentField.toString().trim();
        }

        // Validate content
        if (!documentContent || documentContent.length < 10) {
            return c.json({ 
                error: 'Document must contain at least 10 characters' 
            }, 400);
        }
        if (documentContent.length > 100000) {
            return c.json({ 
                error: 'Document exceeds maximum length of 100,000 characters' 
            }, 400);
        }

        // Generate document ID and timestamp
        const docId = crypto.randomUUID();
        const timestamp = Date.now();

        const document: ComplianceDocument = {
            id: docId,
            title,
            content: documentContent.slice(0, 200) + '...',  // Preview only
            type,
            tags,
            createdAt: timestamp,
            updatedAt: timestamp
        };

        // Track successful operations for cleanup in case of error
        const successfulOps: StorageOperation[] = [];
        
        try {
            // Store metadata in KV first
            await c.env.COMPLIANCE_KV.put(
                `doc:${docId}`,
                JSON.stringify(document)
            );
            successfulOps.push({ type: 'kv', key: `doc:${docId}` });

            // Store content based on available storage
            if (c.env.COMPLIANCE_DOCS) {
                try {
                    await c.env.COMPLIANCE_DOCS.put(
                        `${docId}.txt`,
                        documentContent
                    );
                    successfulOps.push({ type: 'r2', key: `${docId}.txt` });
                } catch (r2Error) {
                    console.error('R2 storage error:', r2Error);
                    // Fallback to KV storage
                    await c.env.COMPLIANCE_KV.put(
                        `doc:${docId}:content`,
                        documentContent
                    );
                    successfulOps.push({ type: 'kv', key: `doc:${docId}:content` });
                }
            } else {
                console.warn('COMPLIANCE_DOCS R2 bucket not available. Using KV fallback.');
                await c.env.COMPLIANCE_KV.put(
                    `doc:${docId}:content`,
                    documentContent
                );
                successfulOps.push({ type: 'kv', key: `doc:${docId}:content` });
            }

            // Generate embeddings and index in vector DB if available
            try {
                const embeddings = await generateEmbeddings(c.env.AI, documentContent);
                
                if (c.env.DOCS_VECTORDB && typeof c.env.DOCS_VECTORDB.insert === 'function') {
                    await c.env.DOCS_VECTORDB.insert([{
                        id: docId,
                        values: embeddings,
                        metadata: {
                            title,
                            type,
                            tags: tags.join(',')
                        }
                    }]);
                } else {
                    console.warn('DOCS_VECTORDB not available. Document will not be indexed for vector search.');
                }
            } catch (indexError) {
                console.error('Vector indexing error:', indexError);
                // Don't fail the upload if indexing fails
            }

            return c.json({
                success: true,
                document: {
                    id: docId,
                    title,
                    type,
                    tags,
                    createdAt: timestamp
                },
                storage: {
                    useR2: Boolean(c.env.COMPLIANCE_DOCS),
                    useVectorDB: Boolean(c.env.DOCS_VECTORDB?.insert)
                }
            });

        } catch (error) {
            // Cleanup any successful operations
            for (const op of successfulOps) {
                try {
                    if (op.type === 'r2' && c.env.COMPLIANCE_DOCS) {
                        await c.env.COMPLIANCE_DOCS.delete(op.key);
                    } else if (op.type === 'kv') {
                        await c.env.COMPLIANCE_KV.delete(op.key);
                    }
                } catch (cleanupError) {
                    console.error(`Cleanup error for ${op.type} ${op.key}:`, cleanupError);
                }
            }

            throw error;
        }
    } catch (e) {
        console.error('Error uploading document:', e);
        return c.json({ 
            error: 'Failed to upload document',
            details: e instanceof Error ? e.message : 'Unknown error'
        }, 500);
    }
});

// List all documents
app.get('/api/admin/documents', async (c) => {
    try {
        console.log('Listing documents from KV...');
        const listResult = await c.env.COMPLIANCE_KV.list({ prefix: 'doc:' });
        console.log('Found', listResult.keys.length, 'keys');
        
        const documents = await Promise.all(
            listResult.keys
                .filter(key => !key.name.includes(':content')) // Skip content keys
                .map(async (keyInfo) => {
                    try {
                        console.log('Processing key:', keyInfo.name);
                        const metadataStr = await c.env.COMPLIANCE_KV.get(keyInfo.name);
                        if (!metadataStr) {
                            console.log('No metadata found for', keyInfo.name);
                            return null;
                        }
                        
                        const metadata = JSON.parse(metadataStr);
                        console.log('Loaded metadata:', metadata.title);
                        return {
                            key: keyInfo.name,
                            metadata: metadata
                        };
                    } catch (error) {
                        console.error('Error parsing document metadata:', error);
                        return null;
                    }
                })
        );
        
        // Filter out null entries
        const validDocuments = documents.filter(doc => doc !== null);
        console.log('Returning', validDocuments.length, 'valid documents');
        
        return c.json({
            success: true,
            count: validDocuments.length,
            documents: validDocuments
        });
    } catch (error) {
        console.error('Error listing documents:', error);
        return c.json({
            error: 'Failed to list documents',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Delete a document
app.delete('/api/admin/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    
    if (!docId) {
        return c.json({ error: 'Document ID is required' }, 400);
    }
    
    try {
        console.log('Deleting document:', docId);
        
        // Delete metadata from KV
        await c.env.COMPLIANCE_KV.delete(`doc:${docId}`);
        
        // Delete content from KV (if stored there)
        await c.env.COMPLIANCE_KV.delete(`doc:${docId}:content`);
        
        // Delete from R2 if available
        if (c.env.COMPLIANCE_DOCS) {
            try {
                await c.env.COMPLIANCE_DOCS.delete(`${docId}.txt`);
                console.log('Deleted from R2');
            } catch (r2Error) {
                console.warn('R2 deletion error (may not exist):', r2Error);
            }
        }
        
        return c.json({
            success: true,
            deleted: docId,
            message: 'Document deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting document:', error);
        return c.json({
            error: 'Failed to delete document',
            details: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Chat endpoint that uses Durable Object for persistent sessions
app.get('/api/chat', async (c) => {
    const query = c.req.query('query');
    const sessionId = c.req.query('sessionId') || crypto.randomUUID();

    if (!query) {
        return c.json({ error: 'Query parameter required' }, 400);
    }

    // Create a Durable Object ID from the session ID
    const id = c.env.CHAT_AGENT.idFromName(sessionId);
    
    // Get the Durable Object stub
    const chatAgent = c.env.CHAT_AGENT.get(id);
    
    // Forward the request to the Durable Object
    const response = await chatAgent.fetch(
        new Request(`https://dummy.url?message=${encodeURIComponent(query)}`)
    );

    // Return the Durable Object's response
    return response;
});

// Debug endpoint to check specific document
app.get('/api/debug/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    
    try {
        // Check metadata in KV
        const metadata = await c.env.COMPLIANCE_KV.get(`doc:${docId}`);
        
        // Check content in R2
        let r2Content = null;
        if (c.env.COMPLIANCE_DOCS) {
            const r2Obj = await c.env.COMPLIANCE_DOCS.get(`${docId}.txt`);
            if (r2Obj) {
                r2Content = await r2Obj.text();
            }
        }
        
        // Check content in KV fallback
        const kvContent = await c.env.COMPLIANCE_KV.get(`doc:${docId}:content`);
        
        return c.json({
            docId,
            metadata: metadata ? JSON.parse(metadata) : null,
            r2Content: r2Content ? {
                length: r2Content.length,
                preview: r2Content.substring(0, 500)
            } : null,
            kvContent: kvContent ? {
                length: kvContent.length,
                preview: kvContent.substring(0, 500)
            } : null
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Debug endpoint to list all documents
app.get('/api/debug/documents', async (c) => {
    try {
        const list = await c.env.COMPLIANCE_KV.list({ prefix: 'doc:' });
        
        const docs = await Promise.all(
            list.keys
                .filter(k => !k.name.includes(':content'))
                .map(async (key) => {
                    const metadata = await c.env.COMPLIANCE_KV.get(key.name);
                    return {
                        key: key.name,
                        metadata: metadata ? JSON.parse(metadata) : null
                    };
                })
        );
        
        return c.json({
            totalKeys: list.keys.length,
            documents: docs
        });
    } catch (error) {
        return c.json({
            error: error instanceof Error ? error.message : 'Unknown error'
        }, 500);
    }
});

// Serve static assets for everything else (MUST BE LAST)
app.all('*', async (c) => {
    return c.env.ASSETS.fetch(c.req.raw);
});

// Export the ChatAgent class for Durable Objects
export { ChatAgent } from './ChatAgent';

export default app;