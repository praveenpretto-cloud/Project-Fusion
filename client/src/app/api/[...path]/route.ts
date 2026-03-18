import { NextResponse } from 'next/server';
import https from 'https';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'POST');
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'GET');
}

async function handleProxy(request: Request, pathArray: string[], method: string) {
    const backendPath = pathArray.join('/');
    const url = new URL(request.url);

    // Pass query params along
    const backendUrl = `https://127.0.0.1:3000/api/${backendPath}${url.search}`;

    const certDir = path.join(process.cwd(), '..', 'certs');
    const agent = new https.Agent({
        rejectUnauthorized: false,
        key: fs.readFileSync(path.join(certDir, 'client.key')),
        cert: fs.readFileSync(path.join(certDir, 'client.crt')),
        ca: fs.readFileSync(path.join(certDir, 'ca.crt')),
    });

    let body = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
        const textStr = await request.text();
        if (textStr) body = textStr;
    }

    try {
        const headers: Record<string, string> = {
            'x-api-key': process.env.API_SECRET_KEY || 'fusion_bank_secret_key_2025',
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
        };

        const idempotencyKey = request.headers.get('x-idempotency-key');
        if (idempotencyKey) {
            headers['x-idempotency-key'] = idempotencyKey;
        }

        const res = await fetch(backendUrl, {
            method,
            headers,
            body,
            agent,
        });

        const data = await res.text();
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            parsed = { text: data };
        }

        return NextResponse.json(parsed, { status: res.status });
    } catch (error) {
        return NextResponse.json(
            {
                error: 'Failed to connect to backend',
                details: error instanceof Error ? error.message : 'Unknown error',
            },
            { status: 500 }
        );
    }
}
