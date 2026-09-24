// Registers the resolve hook that lets the browser modules run under Node.
import { register } from 'node:module';

register('./vendor-hooks.mjs', import.meta.url);
