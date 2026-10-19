import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      runtime: 'nodejs24.x',
      // Tokyo, next to the Supabase database (ap-northeast-1). Vercel's
      // default is iad1 (US East), which put every query across the Pacific.
      regions: ['hnd1']
    })
  }
};

export default config;
