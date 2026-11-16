import type { AuthEvent, AuthEventSink } from '@drefyn/auth';
import { logInfo } from './log.ts';

// Audit events go to the log until there is a store for them. Each field is copied by name,
// so a field added to an event later reaches the log only when it is added here.
export const logEventSink: AuthEventSink = Object.freeze({
  record(event: AuthEvent): Promise<void> {
    logInfo('dashboard.auth_event', {
      type: event.type,
      organizationId: event.organizationId,
      connectionId: event.connectionId,
      domainId: event.domainId,
      domainKey: event.domainKey,
      ...(event.actorUserId === null ? {} : { actorUserId: event.actorUserId }),
      at: event.at.toISOString(),
    });
    return Promise.resolve();
  },
});
