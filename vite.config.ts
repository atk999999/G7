import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative asset paths work both in Google AI Studio and on GitHub Pages.
export default defineConfig({ plugins: [react()], base: './' });
