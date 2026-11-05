import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fixtureIncidentsOn, incidentRouteExists } from '../../../../../../incident/feed.ts';
import { IncidentRoute } from '../../../../../../incident/incident-route.tsx';
import { guardOrganization } from '../../../../../../server/guard.ts';

interface Params {
  params: Promise<{ org: string; product: string; project: string; incident: string }>;
}

export const metadata: Metadata = { title: 'Incident' };

export default async function IncidentPage({ params }: Params) {
  const { org, product, project, incident } = await params;
  await guardOrganization(org);
  if (!fixtureIncidentsOn(process.env) || !incidentRouteExists(product, project, incident)) {
    notFound();
  }
  return <IncidentRoute item={incident} />;
}
