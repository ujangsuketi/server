const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Cache untuk MX record lookups (TTL 1 jam)
const mxCache = new NodeCache({ stdTTL: 3600 });

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 100, // maksimal 100 request per IP
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
            '/validate-stream': {
                method: 'GET',
                description: 'Validate emails with Server-Sent Events',
                parameters: {
                    emails: 'comma-separated email list via query string'
                },
                response: 'Server-Sent Events stream'
            }
        },
        rateLimit: {
            window: '15 minutes',
            maxRequests: 100
        }
    });
});

function isEmailFormatValid(email) {
    // Validasi lebih ketat dengan RFC 5322 compliant regex
    const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    // Validasi panjang email (maks 254 karakter)
    if (email.length > 254) return false;
    
    // Validasi panjang domain (maks 253 karakter)
    const domain = email.split('@')[1];
    if (domain && domain.length > 253) return false;
    
    return re.test(email);
}

async function hasMXRecord(domain) {
    // Cek cache dulu
    const cacheKey = `mx_${domain}`;
    const cached = mxCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const mx = await dns.resolveMx(domain);
        const hasRecords = mx.length > 0;
        
        // Simpan ke cache
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

async function pMap(array, fn, concurrency = Infinity) {
    const results = [];
    const running = [];
    for (const item of array) {
        const p = Promise.resolve(fn(item)).finally(() => {
            const index = running.indexOf(p);
            if (index !== -1) { running.splice(index, 1); }
        });
        running.push(p);
        results.push(p);
        if (running.length >= concurrency) { await Promise.race(running); }
    }
    return Promise.all(results);
}

app.get('/ping', (req, res) => {
    res.json({ 
        message: 'Server aktif dan siap digunakan',
        timestamp: new Date().toISOString()
    });
});

app.get('/validate-stream', async (req, res) => {
    const emails = req.query.emails?.split(',') || [];
    
    // Validasi input lebih ketat
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            error: 'emails must be a comma-separated array via query string',
            example: '/validate-stream?emails=test@example.com,test2@example.com'
        });
    }

    // Batasi jumlah email per request
    if (emails.length > 100) {
        return res.status(400).json({ 
            error: 'Maximum 100 emails per request allowed' 
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const CONCURRENCY_LIMIT = 20;
    const DELAY_MS = 50;
    
    console.log(`Mulai memvalidasi ${emails.length} email dengan jeda ${DELAY_MS}ms.`);
    
    try {
        await pMap(emails, async (email) => {
            try {
                const result = await validateEmail(email.trim());
                console.log(`📬 ${result.email.padEnd(35)} → ${result.result.toUpperCase()} (${result.score})`);
                res.write(`data: ${JSON.stringify(result)}\n\n`);
                await new Promise(r => setTimeout(r, DELAY_MS));
            } catch (err) {
                console.error(`Error memvalidasi email: ${email}`, err);
                res.write(`data: ${JSON.stringify({ email, result: 'error', reason: err.message })}\n\n`);
            }
        }, CONCURRENCY_LIMIT);
        
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

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API docs: http://localhost:${PORT}/docs`);
});
