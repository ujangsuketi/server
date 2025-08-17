const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Cache untuk MX record lookups (TTL 1 jam)
const mxCache = new NodeCache({ stdTTL: 3600 });

// Rate limiting yang lebih longgar untuk batch processing
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 1000, // naikkan untuk batch processing
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(limiter);

const PUBLIC_DOMAINS = [
    'hotmail.com',
    'aol.com',
    'comcast.net',
    'jcom.home.ne.jp',
    'yahoo.com',
    'gmail.com',
    'jcom.zaq.ne.jp',
    'mail.ru',
    'outlook.com'
];

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// API documentation endpoint
app.get('/docs', (req, res) => {
    res.json({
        endpoints: {
            '/ping': {
                method: 'GET',
                description: 'Simple ping endpoint',
                response: 'string'
            },
            '/health': {
                method: 'GET',
                description: 'Health check endpoint',
                response: 'object with system status'
            },
            '/validate-batch': {
                method: 'POST',
                description: 'Validate emails in batch (max 1000 per request)',
                body: { emails: ['email1@example.com', 'email2@example.com'] },
                response: 'JSON array of validation results'
            },
            '/validate-stream': {
                method: 'GET',
                description: 'Validate emails with Server-Sent Events (max 100 per request)',
                parameters: {
                    emails: 'comma-separated email list via query string'
                },
                response: 'Server-Sent Events stream'
            }
        },
        rateLimit: {
            window: '15 minutes',
            maxRequests: 1000
        }
    });
});

function isEmailFormatValid(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.length > 254) return false;
    const domain = email.split('@')[1];
    if (domain && domain.length > 253) return false;
    return re.test(email);
}

async function hasMXRecord(domain) {
    const cacheKey = `mx_${domain}`;
    const cached = mxCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const mx = await dns.resolveMx(domain);
        const hasRecords = mx && mx.length > 0;
        mxCache.set(cacheKey, hasRecords);
        return hasRecords;
    } catch (error) {
        mxCache.set(cacheKey, false);
        return false;
    }
}

async function validateEmail(email) {
    const formatValid = isEmailFormatValid(email);
    const domain = email.split('@')[1]?.toLowerCase();
    let type = 'public';

    if (!formatValid || !domain) {
        return { 
            email, 
            result: 'invalid_format', 
            type, 
            score: 0,
            reason: 'Invalid email format or missing domain'
        };
    }

    const isPublicDomain = PUBLIC_DOMAINS.includes(domain);
    if (!isPublicDomain) {
        type = 'pro';
    }

    const mxValid = await hasMXRecord(domain);
    if (!mxValid) {
        return { 
            email, 
            result: 'undeliverable', 
            type, 
            score: 10,
            reason: 'Domain has no MX records'
        };
    }

    return {
        email,
        result: 'deliverable',
        type,
        score: 90,
        reason: 'Email is valid and domain has MX records'
    };
}

// Batch validation endpoint untuk jumlah besar
app.post('/validate-batch', async (req, res) => {
    const { emails } = req.body;
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            error: 'emails must be an array of email strings',
            example: { emails: ['test@example.com', 'test2@example.com'] }
        });
    }

    if (emails.length > 1000) {
        return res.status(400).json({ 
            error: 'Maximum 1000 emails per request allowed' 
        });
    }

    try {
        const results = [];
        const CONCURRENCY_LIMIT = 50;
        
        // Process in chunks to avoid memory issues
        for (let i = 0; i < emails.length; i += CONCURRENCY_LIMIT) {
            const chunk = emails.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.all(
                chunk.map(email => validateEmail(email.trim()))
            );
            results.push(...chunkResults);
        }

        res.json({
            total: results.length,
            results,
            summary: {
                deliverable: results.filter(r => r.result === 'deliverable').length,
                undeliverable: results.filter(r => r.result === 'undeliverable').length,
                invalid_format: results.filter(r => r.result === 'invalid_format').length
            }
        });
    } catch (error) {
        console.error('Error in validate-batch:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Streaming endpoint untuk jumlah sedang
app.get('/validate-stream', async (req, res) => {
    const emails = req.query.emails?.split(',') || [];
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            error: 'emails must be a comma-separated array via query string',
            example: '/validate-stream?emails=test@example.com,test2@example.com'
        });
    }

    if (emails.length > 100) {
        return res.status(400).json({ 
            error: 'Maximum 100 emails per streaming request. Use POST /validate-batch for larger batches.' 
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const CONCURRENCY_LIMIT = 20;
    const DELAY_MS = 10; // lebih cepat untuk streaming
    
    console.log(`Mulai memvalidasi ${emails.length} email dengan streaming`);
    
    try {
        const processChunk = async (chunk) => {
            const results = await Promise.all(
                chunk.map(email => validateEmail(email.trim()))
            );
            
            for (const result of results) {
                res.write(`data: ${JSON.stringify(result)}\n\n`);
            }
        };

        // Process in chunks
        for (let i = 0; i < emails.length; i += CONCURRENCY_LIMIT) {
            const chunk = emails.slice(i, i + CONCURRENCY_LIMIT);
            await processChunk(chunk);
            await new Promise(r => setTimeout(r, DELAY_MS));
        }

        res.write('event: done\ndata: selesai\n\n');
        res.end();
    } catch (error) {
        console.error('Error in validate-stream:', error);
        res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
        res.end();
    }
});

// Cache stats endpoint
app.get('/cache-stats', (req, res) => {
    res.json({
        mxCache: {
            keys: mxCache.keys().length,
            stats: mxCache.getStats()
        }
    });
});

app.get('/ping', (req, res) => {
    res.json({ 
        message: 'Server aktif dan siap digunakan',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API docs: http://localhost:${PORT}/docs`);
});
