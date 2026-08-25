/**
 * Configuration exports
 */

import aiVendorsJson from './ai-vendors.json';
import type { AIVendorsConfig } from '../types/ai.types';

export const AI_VENDORS_CONFIG: AIVendorsConfig = aiVendorsJson as AIVendorsConfig;

export { getCliInstallInstructions } from './cli-install-instructions';
export { getPythonInstallInstructions } from './python-install-instructions';
