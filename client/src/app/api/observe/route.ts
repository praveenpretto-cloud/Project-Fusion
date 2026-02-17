import { NextResponse } from 'next/server';
import https from 'https';
import fetch from 'node-fetch'; // Next.js polyfills this, but we need the agent

export async function GET() {
    const agent = new https.Agent({
        rejectUnauthorized: false, // Allow self-signed certs from backend
    });

    try {
        const res = await fetch('https://localhost:3000/api/observe', {
            headers: {
                'x-api-key': process.env.API_SECRET_KEY || '',
            },
            agent: agent,
        });

        if (!res.ok) {
            return NextResponse.json(
                { error: `Backend responded with ${res.status}` },
                { status: res.status }
            );
        }

        const data = await res.json();
        return NextResponse.json(data);
    } catch (error: any) {
        console.error('Proxy Error:', error);
        return NextResponse.json(
            { error: 'Failed to connect to backend', details: error.message },
            { status: 500 }
        );
    }
}
