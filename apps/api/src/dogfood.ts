/** Load OpenHuman's founding documents as draft, parsed, auditable dogfood records. */

import { runDocumentConstitutionDogfood } from './dogfood/runtime.js';

await runDocumentConstitutionDogfood();
