import './globals.css';

export const metadata = {
  title: 'Oracle Solver 2026 — Autonomous Oracle Academy Autopilot',
  description:
    'A Chrome extension + local relay that solves Oracle Academy quizzes with AI, advances lessons and sections on its own, and stores every answer in a shared database. Access is issued per user and locked to one device.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
