# SMTP Testing Guide - Boundary Check Implementation

## Overview
Telah ditambahkan fitur baru untuk testing SMTP configuration dengan bounce check yang komprehensif.

## Endpoint Baru

### 1. Test SMTP Connection
**POST** `/test-smtp`

#### Request Body
```json
{
  "email": "info@asdasdf.site",
  "password": "2bUQEqjO_bsx",
  "host": "mail.asdasdf.site",
  "port": 465
}
```

#### Response Success
```json
{
  "success": true,
  "message": "SMTP connection successful",
  "config": {
    "email": "info@asdasdf.site",
    "host": "mail.asdasdf.site",
    "port": 465,
    "secure": true
  }
}
```

#### Response Error
```json
{
  "success": false,
  "message": "SMTP connection failed",
  "error": "Invalid login credentials",
  "code": "EAUTH"
}
```

### 2. Validate SMTP Configuration
**POST** `/validate-smtp-config`

#### Request Body
```json
{
  "email": "info@asdasdf.site",
  "password": "2bUQEqjO_bsxx",
  "host": "mail.asdasdf.site",
  "port": 465
}
```

#### Response
```json
{
  "valid": true,
  "errors": [],
  "config": {
    "email": "info@asdasdf.site",
    "host": "mail.asdasdf.site",
    "port": 465,
    "secure": true
  }
}
```

## Boundary Checks yang Diimplementasikan

### Email Validation
- **Max length**: 254 karakter
- **Format**: Valid email format dengan regex
- **Required**: Tidak boleh kosong

### Password Validation
- **Min length**: 1 karakter
- **Max length**: 512 karakter
- **Type**: String

### Host Validation
- **Min length**: 3 karakter
- **Max length**: 253 karakter
- **Format**: Valid hostname/FQDN

### Port Validation
- **Range**: 1-65535
- **Type**: Integer
- **Secure**: Port 465 untuk SSL

### Timeout Configuration
- **Connection timeout**: 5 detik
- **Greeting timeout**: 5 detik
- **Socket timeout**: 10 detik
- **Total timeout**: 10 detik

## Contoh Penggunaan

### cURL
```bash
# Test SMTP connection
curl -X POST http://localhost:3001/test-smtp \
  -H "Content-Type: application/json" \
  -d '{
    "email": "info@asdasdf.site",
    "password": "2bUQEqjO_bpx",
    "host": "mail.asdasdf.site",
    "port": 465
  }'

# Validate configuration only
curl -X POST http://localhost:3001/validate-smtp-config \
  -H "Content-Type: application/json" \
  -d '{
    "email": "info@asdasdf.site",
    "password": "2bUQEqjO_bsx",
    "host": "mail.asdasdf.site",
    "port": 465
  }'
```

### JavaScript/Node.js
```javascript
const testSMTP = async () => {
  const response = await fetch('http://localhost:3001/test-smtp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'info@asdasdf.site',
      password: '2bUQEqjO_bsxx',
      host: 'mail.asdasdf.site',
      port: 465
    })
  });
  
  const result = await response.json();
  console.log(result);
};
```

## Error Handling
Semua error akan dikembalikan dengan:
- **Error message** yang jelas
- **Error code** dari nodemailer
- **Validation errors** untuk boundary check

## Instalasi
Pastikan untuk menjalankan:
```bash
npm install
```

atau jika belum ada nodemailer:
```bash
npm install nodemailer
