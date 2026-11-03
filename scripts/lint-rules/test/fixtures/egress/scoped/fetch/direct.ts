export async function get(url: string) {
  const response = await fetch(url, { redirect: 'error' });
  return response.status;
}
