# Cloudflare Compliance Agent

A sophisticated compliance documentation search and Q&A system built on Cloudflare Workers, leveraging vector search (Vectorize) with KV+R2 fallback for robust document retrieval and AI-powered responses.

## Features

- 🔍 **Smart Document Search**
  - Vector similarity search via Cloudflare Vectorize
  - Automatic fallback to keyword search using KV+R2
  - Relevance scoring and snippet extraction

- 🤖 **AI-Powered Responses**
  - Context-aware responses using @cf/meta/llama-2-7b-chat-int8
  - Strict adherence to policy documents
  - Automatic citation of relevant sections
  - Persistent chat sessions via Durable Objects

- 📚 **Document Management**
  - Multi-format document upload support
  - Automatic text extraction and indexing
  - Metadata and tagging system
  - Redundant storage (R2 + KV fallback)

## Setup

### Prerequisites

- Cloudflare Workers account with:
  - Workers Unlimited subscription
  - R2 storage enabled
  - Vectorize enabled
  - AI access enabled

### Quick Start

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/mprisha/Cloudflare-compliance-agent.git
   cd Cloudflare-compliance-agent
   npm install
   ```

2. Configure your environment:
   ```bash
   # Create required KV namespace
   npx wrangler kv:namespace create COMPLIANCE_KV

   # Create R2 bucket
   npx wrangler r2 bucket create compliance-documents

   # Create Vectorize index
   npx wrangler vectorize create compliance-rag-index
   ```

3. Update `wrangler.jsonc` with your binding IDs:
   ```jsonc
   {
     "kv_namespaces": [
       {
         "binding": "COMPLIANCE_KV",
         "id": "<your-kv-namespace-id>"
       }
     ],
     "r2_buckets": [
       {
         "binding": "COMPLIANCE_DOCS",
         "bucket_name": "compliance-documents"
       }
     ],
     "vectorize": [
       {
         "binding": "DOCS_VECTORDB",
         "index_name": "compliance-rag-index"
       }
     ]
   }
   ```

4. Deploy:
   ```bash
   npx wrangler deploy
   ```

## Usage

### Adding Documents

Upload compliance documents via the `/api/admin/documents` endpoint:

```bash
curl -X POST https://your-worker.workers.dev/api/admin/documents \
  -F "title=Data Privacy Policy" \
  -F "type=policy" \
  -F "content=<document-text>" \
  -F "tags=privacy,data,security"
```

### Querying Policies

Use the chat interface to ask questions about your compliance documents:

```bash
# One-off query
curl "https://your-worker.workers.dev/api/chat?query=What+is+the+data+retention+period?"

# Session-based chat
curl "https://your-worker.workers.dev/api/chat/session123?query=What+are+the+incident+reporting+requirements?"
```

### Response Format

The agent provides structured responses with:
- Direct answers with section references
- Exact policy quotes
- Relevance scores for referenced documents
- Conversation history (in session mode)

Example response:
```json
{
  "response": "Based on Data Privacy Policy, Section 4.2, unauthorized access attempts must be reported within 24 hours of discovery. Quote: 'Any unauthorized access or attempted access shall be reported to the Data Privacy Officer within 24 hours of discovery.'",
  "context": [
    {
      "title": "Data Privacy Policy",
      "type": "policy",
      "relevanceScore": 0.92
    }
  ]
}
```

## Architecture

- **Main Worker**: Handles HTTP routing, document processing, and chat orchestration
- **Durable Objects**: Maintains chat session state and conversation history
- **Storage Layer**:
  - R2: Primary document storage
  - KV: Metadata and fallback content storage
  - Vectorize: Semantic search index
- **AI Layer**:
  - Document embedding: `@cf/baai/bge-base-en-v1.5`
  - Chat responses: `@cf/meta/llama-2-7b-chat-int8`

## Development

Run locally with remote bindings:
```bash
npx wrangler dev --remote
```

For local-only development (uses KV+R2 fallback):
```bash
npx wrangler dev
```

## Error Handling

The system implements graceful degradation:
- Falls back to KV if R2 is unavailable
- Uses keyword search if Vectorize is unavailable
- Maintains functionality even with partial binding availability

## License

MIT License - See LICENSE file for details.
