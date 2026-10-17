'use client';

import { useEffect } from 'react';

// Fades sections in on scroll. Respects prefers-reduced-motion via CSS.
export default function Reveal({ children, d = 0, as: Tag = 'div', className = '' }) {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <Tag className={`reveal ${className}`} style={{ '--d': d }}>
      {children}
    </Tag>
  );
}
