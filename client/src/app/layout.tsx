import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Project Fusion',
    description: 'Enterprise Financial Infrastructure Application',
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                suppressHydrationWarning={true}
                className="antialiased font-sans"
            >
                {children}
            </body>
        </html>
    );
}
