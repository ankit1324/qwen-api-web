import { startServer } from './server';

// Handle unhandled rejections to prevent crashing the whole proxy silently
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

startServer();
