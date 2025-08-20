
const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3001;

// Cache untuk MX record lookups (TTL 1 jam)
const mxCache = new NodeCache({ stdTTL: 3600 });

// Utility function untuk filter duplikat email (case-insensitive)
function filterDuplicateEmails(emails) {
    const seen = new Set();
    const uniqueEmails = [];
    const duplicates = [];

    emails.forEach(email => {
        const normalizedEmail = email.trim().toLowerCase();
        if (seen.has(normalizedEmail)) {
            duplicates.push(email.trim());
        } else {
            seen.add(normalizedEmail);
            uniqueEmails.push(email.trim());
        }
    });

    return {
        uniqueEmails,
        duplicates,
        totalOriginal: emails.length,
        totalUnique: uniqueEmails.length,
        totalDuplicates: duplicates.length
    };
}

// Rate limiting yang lebih longgar untuk batch processing
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 10000, // naikkan untuk batch processing besar
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // naikkan limit body size
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
                description: 'Validate emails in batch (max 10000 per request)',
                body: { 
                    emails: ['email1@example.com', 'email2@example.com'],
                    filterDuplicates: false // optional, default: false
                },
                response: 'JSON array of validation results with optional duplicate filter info'
            },
            '/validate-stream': {
                method: 'GET',
                description: 'Validate emails with Server-Sent Events (max 1000 per request)',
                parameters: {
                    emails: 'comma-separated email list via query string',
                    filterDuplicates: 'boolean parameter to filter duplicates (true/false)'
                },
                response: 'Server-Sent Events stream with optional duplicate_info event'
            }
        },
        features: {
            duplicateFilter: {
                description: 'Filter duplicate emails (case-insensitive)',
                usage: 'Set filterDuplicates=true in requests',
                behavior: 'Removes duplicate emails before validation, returns duplicate info'
            }
        },
        rateLimit: {
            window: '15 minutes',
            maxRequests: 10000
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

// Batch validation endpoint untuk jumlah besar dengan chunking
app.post('/validate-batch', async (req, res) => {
    const { emails, filterDuplicates = false } = req.body;
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            error: 'emails must be an array of email strings',
            example: { emails: ['test@example.com', 'test2@example.com'] }
        });
    }

    if (emails.length > 10000) {
        return res.status(400).json({ 
            error: 'Maximum 10000 emails per request allowed' 
        });
    }

    try {
        let emailsToProcess = emails;
        let duplicateInfo = null;

        // Filter duplikat jika diminta
        if (filterDuplicates) {
            duplicateInfo = filterDuplicateEmails(emails);
            emailsToProcess = duplicateInfo.uniqueEmails;
        }

        const results = [];
        const CONCURRENCY_LIMIT = 100; // lebih agresif untuk kecepatan
        
        console.log(`Processing ${emailsToProcess.length} emails in batches...`);
        
        // Process in chunks to avoid memory issues
        for (let i = 0; i < emailsToProcess.length; i += CONCURRENCY_LIMIT) {
            const chunk = emailsToProcess.slice(i, i + CONCURRENCY_LIMIT);
            const chunkResults = await Promise.allSettled(
                chunk.map(email => validateEmail(email.trim()))
            );
            
            const processedResults = chunkResults.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        email: chunk[index],
                        result: 'error',
                        reason: result.reason.message || 'Validation failed'
                    };
                }
            });
            
            results.push(...processedResults);
            
            // Log progress
            console.log(`Processed ${Math.min(i + CONCURRENCY_LIMIT, emailsToProcess.length)}/${emailsToProcess.length} emails`);
        }

        const response = {
            total: results.length,
            results,
            summary: {
                deliverable: results.filter(r => r.result === 'deliverable').length,
                undeliverable: results.filter(r => r.result === 'undeliverable').length,
                invalid_format: results.filter(r => r.result === 'invalid_format').length,
                error: results.filter(r => r.result === 'error').length
            }
        };

        // Tambahkan info duplikat jika filtering diaktifkan
        if (filterDuplicates && duplicateInfo) {
            response.duplicateFilter = duplicateInfo;
        }

        res.json(response);
    } catch (error) {
        console.error('Error in validate-batch:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Streaming endpoint untuk jumlah besar dengan chunking
app.get('/validate-stream', async (req, res) => {
    const emails = req.query.emails?.split(',') || [];
    const filterDuplicates = req.query.filterDuplicates === 'true';
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            error: 'emails must be a comma-separated array via query string',
            example: '/validate-stream?emails=test@example.com,test2@example.com&filterDuplicates=true'
        });
    }

    if (emails.length > 1000) {
        return res.status(400).json({ 
            error: 'Maximum 1000 emails per streaming request. Use POST /validate-batch for larger batches.' 
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    let emailsToProcess = emails;
    let duplicateInfo = null;

    // Filter duplikat jika diminta
    if (filterDuplicates) {
        duplicateInfo = filterDuplicateEmails(emails);
        emailsToProcess = duplicateInfo.uniqueEmails;
        
        // Kirim info duplikat sebagai event pertama
        res.write(`event: duplicate_info\ndata: ${JSON.stringify(duplicateInfo)}\n\n`);
    }

    const CONCURRENCY_LIMIT = 50;
    const DELAY_MS = 5; // lebih cepat
    
    console.log(`Mulai memvalidasi ${emailsToProcess.length} email dengan streaming`);
    
    try {
        const processChunk = async (chunk) => {
            const chunkResults = await Promise.allSettled(
                chunk.map(email => validateEmail(email.trim()))
            );
            
            const processedResults = chunkResults.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        email: chunk[index],
                        result: 'error',
                        reason: result.reason.message || 'Validation failed'
                    };
                }
            });
            
            for (const result of processedResults) {
                res.write(`data: ${JSON.stringify(result)}\n\n`);
            }
        };

        // Process in chunks
        for (let i = 0; i < emailsToProcess.length; i += CONCURRENCY_LIMIT) {
            const chunk = emailsToProcess.slice(i, i + CONCURRENCY_LIMIT);
            await processChunk(chunk);
            
            // Small delay to prevent overwhelming
            if (i + CONCURRENCY_LIMIT < emailsToProcess.length) {
                await new Promise(r => setTimeout(r, DELAY_MS));
            }
        }

        res.write('event: done\ndata: selesai\n\n');
        res.end();
    } catch (error) {
        console.error('Error in validate-stream:', error);
        res.write(`data: ${JSON.stringify({ error: 'Internal server error', details: error.message })}\n\n`);
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

// SMTP Configuration Validation and Testing with Boundary Check
function validateSMTPConfig(config) {
    const errors = [];
    
    // Boundary checks for SMTP configuration
    if (!config.email || typeof config.email !== 'string' || config.email.length > 254) {
        errors.push('Email must be a valid string (max 254 chars)');
    }
    
    if (!config.password || typeof config.password !== 'string' || config.password.length < 1 || config.password.length > 512) {
        errors.push('Password must be a valid string (1-512 chars)');
    }
    
    if (!config.host || typeof config.host !== 'string' || config.host.length < 3 || config.host.length > 253) {
        errors.push('Host must be a valid string (3-253 chars)');
    }
    
    if (!config.port || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        errors.push('Port must be a valid integer (1-65535)');
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (config.email && !emailRegex.test(config.email)) {
        errors.push('Invalid email format');
    }
    
    // Validate host format
    const hostRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (config.host && !hostRegex.test(config.host)) {
        errors.push('Invalid host format');
    }
    
    return errors;
}

async function testSMTPConnection(config) {
    try {
        // Validate configuration first
        const validationErrors = validateSMTPConfig(config);
        if (validationErrors.length > 0) {
            return {
                success: false,
                errors: validationErrors,
                message: 'Configuration validation failed'
            };
        }
        
        // Create transporter with boundary-checked configuration
        const transporter = nodemailer.createTransporter({
            host: config.host,
            port: config.port,
            secure: config.port === 465, // SSL for port 465
            auth: {
                user: config.email,
                pass: config.password
            },
            timeout: 10000, // 10 second timeout
            connectionTimeout: 5000, // 5 second connection timeout
            greetingTimeout: 5000, // 5 second greeting timeout
            socketTimeout: 10000 // 10 second socket timeout
        });
        
        // Verify connection with boundary checks
        const verifyResult = await transporter.verify();
        
        return {
            success: true,
            message: 'SMTP connection successful',
            config: {
                email: config.email,
                host: config.host,
                port: config.port,
                secure: config.port === 465
            },
            verifyResult
        };
        
    } catch (error) {
        return {
            success: false,
            message: 'SMTP connection failed',
            error: error.message,
            code: error.code
        };
    }
}

// SMTP Test endpoint with boundary check
app.post('/test-smtp', async (req, res) => {
    const { email, password, host, port } = req.body;
    
    // Input boundary check
    if (!email || !password || !host || !port) {
        return res.status(400).json({
            error: 'Missing required fields',
            required: ['email', 'password', 'host', 'port'],
            example: {
                email: 'info@asdasdf.site',
                password: '2bUQEqjO_bpx',
                host: 'mail.asdasdf.site',
                port: 465
            }
        });
    }
    
    const config = {
        email: String(email).trim(),
        password: String(password),
        host: String(host).trim(),
        port: parseInt(port)
    };
    
    try {
        const result = await testSMTPConnection(config);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// SMTP Configuration validation endpoint
app.post('/validate-smtp-config', (req, res) => {
    const { email, password, host, port } = req.body;
    
    const config = {
        email: String(email || '').trim(),
        password: String(password || ''),
        host: String(host || '').trim(),
        port: parseInt(port || 0)
    };
    
    const errors = validateSMTPConfig(config);
    
    res.json({
        valid: errors.length === 0,
        errors,
        config: errors.length === 0 ? {
            email: config.email,
            host: config.host,
            port: config.port,
            secure: config.port === 465
        } : null
    });
});

app.get('/ping', (req, res) => {
    res.json({ 
        message: 'Server aktif dan siap digunakan',
        timestamp: new Date().toISOString()
    });
});

// Error handling untuk memory issues
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📚 API docs: http://localhost:${PORT}/docs`);
    console.log(`💾 Memory limit: ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`);
});
