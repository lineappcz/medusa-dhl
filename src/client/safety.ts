export const joinCarrierUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\//, ""), normalizedBase).toString()
}
