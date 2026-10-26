import { createMemoryLedger } from '../src/index.ts';
import { amountPropertiesContract } from './contract/amount-properties.ts';
import { entryAmountsContract } from './contract/amounts.ts';
import { concurrencyContract } from './contract/concurrency.ts';
import { idempotencyContract } from './contract/idempotency.ts';
import { isolationContract } from './contract/isolation.ts';
import { ledgerPropertiesContract } from './contract/ledger-properties.ts';
import { ledgerContract } from './contract/ledger.ts';

const makeLedger = createMemoryLedger;

entryAmountsContract(makeLedger);
amountPropertiesContract(makeLedger);
ledgerContract(makeLedger);
idempotencyContract(makeLedger);
isolationContract(makeLedger);
concurrencyContract(makeLedger);
ledgerPropertiesContract(makeLedger);
