import { BUSINESS_LAUNCH }          from './business-launch.js';
import { DIGITAL_PRESENCE_LAUNCH }  from './digital-presence-launch.js';
import { OPERATING_PARTNERSHIP }    from './operating-partnership.js';
import { BUSINESS_OPERATIONS }      from './business-operations.js';
import { DIGITAL_PRESENCE_OPERATIONS } from './digital-presence-operations.js';
import { MOBILE_APP } from './mobile-app.js';

export const REGISTRY = [BUSINESS_LAUNCH, DIGITAL_PRESENCE_LAUNCH, OPERATING_PARTNERSHIP, BUSINESS_OPERATIONS, DIGITAL_PRESENCE_OPERATIONS, MOBILE_APP];

export function getPlaybook(id) {
  return REGISTRY.find(p => p.id === id) || null;
}
