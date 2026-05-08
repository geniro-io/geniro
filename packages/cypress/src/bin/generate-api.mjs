#!/usr/bin/env node
import { generateClient } from '@packages/cypress';

const [url, output] = process.argv.slice(2);

generateClient({ url, output })
  .then(() => {
    console.log('Client generated');
  })
  .catch(console.error);
