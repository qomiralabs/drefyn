import { withWebhookLedger, type Database } from '@drefyn/db';
import { sql } from 'kysely';
import { isDeliveryId, isEventName, type DeliveryClaim, type DeliveryLedger } from './webhook.ts';

// Long past the three days GitHub lets anyone redeliver, so a replay inside that window is
// always caught.
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Each claim also ages out at most this many old rows, so the table stays bounded without a
// job of its own and no claim does unbounded work.
const PURGE_BATCH = 100;

function checked(claim: DeliveryClaim): DeliveryClaim {
  if (
    !isDeliveryId(claim.deliveryId) ||
    !isEventName(claim.event) ||
    claim.bodySha256.byteLength !== 32
  ) {
    throw new TypeError('github: invalid delivery claim');
  }
  return claim;
}

export function createDeliveryLedger(deps: { readonly db: Database }): DeliveryLedger {
  const { db } = deps;
  const retentionSeconds = DELIVERY_RETENTION_MS / 1000;
  return Object.freeze({
    async claim(input: DeliveryClaim): Promise<'new' | 'replayed'> {
      const claim = checked(input);
      const taken = await withWebhookLedger(db, async (tx) => {
        await tx
          .deleteFrom('github_webhook_deliveries')
          .where('delivery_id', 'in', (eb) =>
            eb
              .selectFrom('github_webhook_deliveries')
              .select('delivery_id')
              .where(
                'received_at',
                '<',
                sql<Date>`now() - make_interval(secs => ${retentionSeconds})`,
              )
              .limit(PURGE_BATCH),
          )
          .execute();
        // Either key taken before, the id or the body, makes this a replay.
        return tx
          .insertInto('github_webhook_deliveries')
          .values({
            delivery_id: claim.deliveryId,
            body_sha256: Buffer.from(claim.bodySha256),
            event: claim.event,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('delivery_id')
          .executeTakeFirst();
      });
      return taken === undefined ? 'replayed' : 'new';
    },

    async release(deliveryId: string): Promise<void> {
      if (!isDeliveryId(deliveryId)) throw new TypeError('github: invalid delivery id');
      await withWebhookLedger(db, (tx) =>
        tx.deleteFrom('github_webhook_deliveries').where('delivery_id', '=', deliveryId).execute(),
      );
    },
  });
}
