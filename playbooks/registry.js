import { BUSINESS_LAUNCH }          from './business-launch.js';
import { DIGITAL_PRESENCE_LAUNCH }  from './digital-presence-launch.js';
import { OPERATING_PARTNERSHIP }    from './operating-partnership.js';

export const REGISTRY = [BUSINESS_LAUNCH, DIGITAL_PRESENCE_LAUNCH, OPERATING_PARTNERSHIP];

export function getPlaybook(id) {
  return REGISTRY.find(p => p.id === id) || null;
}
