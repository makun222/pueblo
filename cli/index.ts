#!/usr/bin/env node

export * from '../src/cli/index';

import { main } from '../src/cli/index';
import { formatCommandResult, formatError } from '../src/shared/result';

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(formatCommandResult(formatError(error)));
    process.exitCode = 1;
  });
}