const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const helmet = require('helmet'); // Tambah security
const validator = require('validator'); // Buat sanitize
const winston = require('winston'); // Logging
const mailcheck = require('mailcheck'); // Typo check
const fs = require('fs'); // Buat CSV export
const app = express();
const PORT = process.env.PORT || 3001;

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' })
    ]
});

// Cache untuk MX record lookups (TTL 1 jam)
const mxCache = new NodeCache({ stdTTL: 3600 });

// List disposable domains (sample dari GitHub; bisa fetch dynamic via axios)
const DISPOSABLE_DOMAINS = new Set([
    'tempmail.com', 'mailinator.com', '10minutemail.com', 'guerrillamail.com', // Tambah lebih banyak dari https://github.com/disposable-email-domains/disposable-email-domains
    // Full list bisa load dari file atau API
]);

// Utility function untuk filter duplikat email (case-insensitive) - udah bagus, tapi tambah log
function filterDuplicateEmails(emails) {
    const seen = new Set();
    const uniqueEmails = [];
    const duplicates = [];
    emails.forEach(email => {
        const sanitized = validator.trim(email); // Sanitize tambahan
        const normalizedEmail = sanitized.toLowerCase();
        if (seen.has(normalizedEmail)) {
            duplicates.push(sanitized);
        } else {
            seen.add(normalizedEmail);
            uniqueEmails.push(sanitized);
        }
    });
    logger.info(`Filtered emails: ${emails.length} original, ${uniqueEmails.length} unique`);
    return {
        uniqueEmails,
        duplicates,
        totalOriginal: emails.length,
        totalUnique: uniqueEmails.length,
        totalDuplicates: duplicates.length
    };
}

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(helmet()); // Security headers, enforce HTTPS dll
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(limiter);

// Public domains list (udah ada)
const PUBLIC_DOMAINS = [
    'hotmail.com', 'aol.com', 'comcast.net', 'jcom.home.ne.jp', 'yahoo.com', 'gmail.com', 'jcom.zaq.ne.jp', 'mail.ru', 'outlook.com'
];

// Health check, docs, ping - udah bagus, skip copy

function isEmailFormatValid(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email.length > 254) return false;
    const domain = email.split('@')[1];
    if (domain && domain.length > 253) return false;
    return re.test(email);
}

async function hasMXRecord(domain, retries = 3) { // Tambah retry
    const cacheKey = `mx_${domain}`;
    const cached = mxCache.get(cacheKey);
    if (cached !== undefined) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const mx = await dns.resolveMx(domain);
            const hasRecords = mx && mx.length > 0;
            mxCache.set(cacheKey, hasRecords);
            return hasRecords;
        } catch (error) {
            logger.error(`MX lookup failed for ${domain}, attempt ${attempt}: ${error.message}`);
            if (attempt === retries) {
                mxCache.set(cacheKey, false);
                return false;
            }
            await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
        }
    }
}

async function checkSPF(domain) { // Tambah SPF check
    try {
        const txtRecords = await dns.resolveTxt(domain);
        return txtRecords.some(record => record.join('').includes('v=spf1'));
    } catch {
        return false;
    }
}

async function validateEmail(email) {
    const sanitized = validator.normalizeEmail(email); // Sanitize & normalize
    const formatValid = isEmailFormatValid(sanitized);
    const domain = sanitized.split('@')[1]?.toLowerCase();
    let type = 'public';
    if (!formatValid || !domain) {
        return {
            email: sanitized,
            result: 'invalid_format',
            type,
            score: 0,
            reason: 'Invalid email format or missing domain'
        };
    }

    // Tambah disposable check
    if (DISPOSABLE_DOMAINS.has(domain)) {
        return {
            email: sanitized,
            result: 'disposable',
            type,
            score: 0,
            reason: 'Disposable email domain'
        };
    }

    const isPublicDomain = PUBLIC_DOMAINS.includes(domain);
    if (!isPublicDomain) type = 'pro';

    const mxValid = await hasMXRecord(domain);
    if (!mxValid) {
        return {
            email: sanitized,
            result: 'undeliverable',
            type,
            score: 10,
            reason: 'Domain has no MX records'
        };
    }

    // Tambah SPF
    const spfValid = await checkSPF(domain);
    const score = spfValid ? 95 : 80;

    // Tambah typo suggestion
    const suggestion = mailcheck.suggest(sanitized);
    const typoInfo = suggestion ? { suggestion: suggestion.full } : null;

    return {
        email: sanitized,
        result: 'deliverable',
        type,
        score,
        reason: 'Email is valid, domain has MX records' + (spfValid ? ' and SPF' : ''),
        typo: typoInfo
    };
}

// Batch validation - tambah sanitize emails dulu
app.post('/validate-batch', async (req, res) => {
    let { emails, filterDuplicates = false } = req.body;
    emails = emails.map(e => validator.escape(e)); // Sanitize input

    // ... (rest udah bagus, tapi tambah log di catch)
    try {
        // ...
    } catch (error) {
        logger.error(`Batch validation error: ${error.stack}`);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Streaming - similar, tambah sanitize

// Tambah endpoint export unique CSV
app.post('/export-unique-emails', (req, res) => {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails)) {
        return res.status(400).json({ error: 'Emails must be an array' });
    }

    const duplicateInfo = filterDuplicateEmails(emails);
    const uniqueEmails = duplicateInfo.uniqueEmails;

    const csvContent = uniqueEmails.join('\n');
    fs.writeFileSync('unique_emails.csv', csvContent);

    res.download('unique_emails.csv', 'unique_emails.csv', (err) => {
        if (err) logger.error(`Export error: ${err}`);
        fs.unlinkSync('unique_emails.csv'); // Clean up
    });
});

// SMTP validate & test - tambah secure: true kalau port 465, dan log

// ... rest kode lama

app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
});
