import { NextResponse, NextRequest } from 'next/server';
import https from 'https';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'POST');
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'GET');
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'PUT');
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'DELETE');
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
    const resolvedParams = await params;
    return handleProxy(request, resolvedParams.path, 'PATCH');
}

async function handleProxy(request: NextRequest, pathArray: string[], method: string) {
    const backendPath = pathArray.join('/');
    const url = new URL(request.url);

    // ── LOCAL OBSERVABILITY SECURITY GUARD (AI-3.5.1) ───────────────────────────
    // Observability traces and metrics are strictly restricted to local browser loopback.
    // If a remote client calls Next.js proxy for these endpoints, reject immediately
    // rather than forwarding with the Next.js loopback identity.
    const isObservabilityEndpoint =
        backendPath.startsWith('ai/observability/traces') ||
        backendPath === 'ai/observability/metrics';

    if (isObservabilityEndpoint) {
        const hostHeader = (request.headers.get('host') || '').toLowerCase();
        const hostname = url.hostname.toLowerCase();

        const isLoopbackHost =
            (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') &&
            (hostHeader.startsWith('localhost:') ||
             hostHeader === 'localhost' ||
             hostHeader.startsWith('127.0.0.1:') ||
             hostHeader === '127.0.0.1' ||
             hostHeader.startsWith('[::1]:') ||
             hostHeader === '[::1]');

        // Check if caller provides forwarding headers indicating an external client
        const forwardedFor = request.headers.get('x-forwarded-for');
        const realIp = request.headers.get('x-real-ip');
        const isForwardedFromExternal = Boolean(
            (forwardedFor && !forwardedFor.split(',')[0].trim().match(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)) ||
            (realIp && !realIp.trim().match(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/))
        );

        if (!isLoopbackHost || isForwardedFromExternal) {
            return NextResponse.json(
                {
                    error: 'FORBIDDEN',
                    message: 'Observability telemetry endpoints are restricted to local loopback access only.'
                },
                { status: 403 }
            );
        }
    }

    // Use HTTP when LOCAL_ONLY — backend runs plain HTTP in local mode
    const isLocal = process.env.LOCAL_ONLY === 'true';
    const protocol = isLocal ? 'http' : 'https';
    const backendUrl = `${protocol}://127.0.0.1:3000/api/${backendPath}${url.search}`;

    // Only load certs for HTTPS (mTLS) mode
    let agent: https.Agent | undefined;
    if (!isLocal) {
        const certDir = path.join(process.cwd(), '..', 'certs');
        const keyPath = path.join(certDir, 'client.key');
        const certPath = path.join(certDir, 'client.crt');
        const caPath = path.join(certDir, 'ca.crt');

        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath) || !fs.existsSync(caPath)) {
            return NextResponse.json(
                { error: 'TLS certificate configuration missing for upstream HTTPS connection (Workstream 0 containment)' },
                { status: 503 }
            );
        }

        agent = new https.Agent({
            rejectUnauthorized: true, // Workstream 0: strict certificate verification enforced
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ca: fs.readFileSync(caPath),
        });
    }

    let body = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
        const textStr = await request.text();
        if (textStr) body = textStr;
    }

    try {
        // Workstream 0 Containment: Read server-only secret; fail closed if missing (zero hardcoded fallback)
        const secretKey = (process.env.API_SECRET_KEY || '').trim();
        if (!secretKey) {
            return NextResponse.json(
                { error: 'Backend service credentials unconfigured (Workstream 0 containment: missing API_SECRET_KEY)' },
                { status: 503 }
            );
        }

        const headers: Record<string, string> = {
            'x-api-key': secretKey,
            'Content-Type': request.headers.get('Content-Type') || 'application/json',
        };

        // Forward session and identity headers from client
        const cookie = request.headers.get('cookie');
        if (cookie) {
            headers['cookie'] = cookie;
        }

        const authHeader = request.headers.get('authorization');
        if (authHeader) {
            headers['authorization'] = authHeader;
        }

        const csrfToken = request.headers.get('x-csrf-token') || request.headers.get('x-xsrf-token');
        if (csrfToken) {
            headers['x-csrf-token'] = csrfToken;
        }

        const origin = request.headers.get('origin');
        if (origin) {
            headers['origin'] = origin;
        }

        const referer = request.headers.get('referer');
        if (referer) {
            headers['referer'] = referer;
        }

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

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/event-stream')) {
            const responseHeaders = new Headers();
            responseHeaders.set('Content-Type', 'text/event-stream');
            responseHeaders.set('Cache-Control', 'no-cache, no-transform');
            responseHeaders.set('Connection', 'keep-alive');
            responseHeaders.set('X-Accel-Buffering', 'no');

            // Pipe upstream body directly for genuine streaming
            return new Response(res.body as unknown as ReadableStream, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        const data = await res.text();
        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            parsed = { text: data };
        }

        const responseHeaders = new Headers();
        // Preserve multiple distinct Set-Cookie headers without collapsing or corrupting them
        type ExtendedHeaders = Headers & {
            raw?: () => Record<string, string[]>;
            getSetCookie?: () => string[];
        };
        const extendedHeaders = res.headers as unknown as ExtendedHeaders;
        const rawSetCookies: string[] = 
            extendedHeaders.raw?.()['set-cookie'] ||
            (extendedHeaders.getSetCookie ? extendedHeaders.getSetCookie() : []) ||
            (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);

        for (const cookieStr of rawSetCookies) {
            responseHeaders.append('set-cookie', cookieStr);
        }

        return NextResponse.json(parsed, { status: res.status, headers: responseHeaders });
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
