// Display names of the monitorings, shared by the public API, the Strapi sync and the front.
export const SOURCE_LABELS: Record<string, string> = {
  bestchange: "BestChange",
  kursexpert: "KursExpert",
  changeinfo: "ChangeInfo",
  emon: "E-mon",
  wellcrypto: "Wellcrypto",
};
export const sourceLabel = (id: string): string => SOURCE_LABELS[id] ?? id;
