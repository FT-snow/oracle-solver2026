/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // static site — Vercel serves it with zero server cost
  images: { unoptimized: true }
};

export default nextConfig;
