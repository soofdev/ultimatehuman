import typography from '@tailwindcss/typography';
import containerQueries from '@tailwindcss/container-queries';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      transitionTimingFunction: {
        'smooth': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'ease-in-smooth': 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      },
      animation: {
        'fade-in': 'fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-right': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-slow': 'pulseSlow 3s ease-in-out infinite',
        'bounce-in': 'bounceIn 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        'shimmer': 'shimmer 2s infinite',
        // Staggered animations
        'slide-up-1': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 0ms',
        'slide-up-2': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 100ms',
        'slide-up-3': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 200ms',
        'slide-up-4': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 300ms',
        'slide-up-5': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 400ms',
        'slide-right-1': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 0ms',
        'slide-right-2': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 100ms',
        'slide-right-3': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 200ms',
        'slide-right-4': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 300ms',
        'slide-right-5': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 400ms',
        'slide-right-6': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 500ms',
        'slide-right-7': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 600ms',
        'slide-right-8': 'slideRight 0.6s cubic-bezier(0.16, 1, 0.3, 1) both 700ms',
      },
      typography: (theme) => ({
        // Long-form reading defaults for the blog: comfortable measure,
        // generous rhythm, real typographic scale, neutral ink (no gray-on-color).
        blog: {
          css: {
            '--tw-prose-body': theme('colors.slate.700'),
            '--tw-prose-headings': theme('colors.slate.900'),
            '--tw-prose-links': theme('colors.slate.900'),
            '--tw-prose-quotes': theme('colors.slate.900'),
            '--tw-prose-quote-borders': theme('colors.slate.900'),
            '--tw-prose-bullets': theme('colors.slate.400'),
            '--tw-prose-captions': theme('colors.slate.500'),
            '--tw-prose-code': theme('colors.slate.900'),
            '--tw-prose-pre-bg': theme('colors.slate.900'),
            '--tw-prose-pre-code': theme('colors.slate.100'),
            fontSize: '1.1875rem',
            lineHeight: '1.8',
            maxWidth: '68ch',
            p: { marginTop: '1.4em', marginBottom: '1.4em' },
            h2: { fontWeight: '700', letterSpacing: '-0.02em', marginTop: '2.2em', marginBottom: '0.7em', lineHeight: '1.25' },
            h3: { fontWeight: '700', letterSpacing: '-0.01em', marginTop: '1.8em', marginBottom: '0.6em' },
            a: { textDecoration: 'underline', textUnderlineOffset: '3px', textDecorationThickness: '1px', fontWeight: '500' },
            blockquote: { fontStyle: 'normal', fontWeight: '500', borderLeftWidth: '3px', paddingLeft: '1.25em' },
            img: { borderRadius: '0.75rem', marginTop: '2em', marginBottom: '2em' },
            'figure figcaption': { textAlign: 'center', fontSize: '0.875rem' },
            code: { fontWeight: '500', backgroundColor: theme('colors.slate.100'), padding: '0.15em 0.4em', borderRadius: '0.3rem' },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: { borderRadius: '0.75rem', fontSize: '0.9375rem' },
          },
        },
      }),
      keyframes: {
        fadeIn: {
          '0%': { 
            opacity: '0', 
            transform: 'translateY(30px) scale(0.95)' 
          },
          '100%': { 
            opacity: '1', 
            transform: 'translateY(0) scale(1)' 
          },
        },
        slideUp: {
          '0%': { 
            opacity: '0', 
            transform: 'translateY(40px) scale(0.9)' 
          },
          '100%': { 
            opacity: '1', 
            transform: 'translateY(0) scale(1)' 
          },
        },
        slideRight: {
          '0%': { 
            opacity: '0', 
            transform: 'translateX(-30px) scale(0.95)' 
          },
          '100%': { 
            opacity: '1', 
            transform: 'translateX(0) scale(1)' 
          },
        },
        pulseSlow: {
          '0%, 100%': { 
            opacity: '0.4',
            transform: 'scale(1)'
          },
          '50%': { 
            opacity: '0.7',
            transform: 'scale(1.05)'
          },
        },
        bounceIn: {
          '0%': { 
            opacity: '0',
            transform: 'translateY(10px) scale(0.8)'
          },
          '60%': { 
            opacity: '1',
            transform: 'translateY(-5px) scale(1.05)'
          },
          '100%': { 
            opacity: '1',
            transform: 'translateY(0) scale(1)'
          },
        },
        shimmer: {
          '0%': {
            transform: 'translateX(-100%)'
          },
          '100%': {
            transform: 'translateX(100%)'
          },
        },
      },
    },
  },
  plugins: [typography, containerQueries],
};
