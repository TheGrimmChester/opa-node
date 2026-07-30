'use strict';

/**
 * Wave 13-4: detect common Node frameworks from installed modules / argv.
 */

function detectFramework() {
  const checks = [
    ['next', 'next'],
    ['nuxt', 'nuxt'],
    ['@nestjs/core', 'nestjs'],
    ['express', 'express'],
    ['fastify', 'fastify'],
    ['koa', 'koa'],
    ['@hapi/hapi', 'hapi'],
    ['restify', 'restify'],
    ['apollo-server', 'apollo'],
    ['@apollo/server', 'apollo'],
    ['graphql-yoga', 'graphql-yoga']
  ];
  for (const [mod, name] of checks) {
    try {
      require.resolve(mod);
      return name;
    } catch (e) { /* not installed */ }
  }
  if (process.env.NEXT_RUNTIME || process.env.NEXT_PUBLIC_VERCEL_ENV) return 'next';
  return 'node';
}

module.exports = { detectFramework };
