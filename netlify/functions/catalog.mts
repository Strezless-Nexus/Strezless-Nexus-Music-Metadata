import type { Config, Context } from "@netlify/functions";
import { AuthError, getUser, verifyRequestOrigin } from "@netlify/identity";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { artists, releases, tracks } from "../../db/schema.js";

type Fields = Record<string, unknown>;

class BadRequest extends Error {}

const str = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

// Normalizes an industry code (strip spaces, dashes, dots; uppercase) and checks it against a pattern.
const code = (v: unknown, label: string, pattern: RegExp, hint: string): string | null => {
  const s = str(v);
  if (!s) return null;
  const clean = s.replace(/[\s.\-]/g, "").toUpperCase();
  if (!pattern.test(clean)) throw new BadRequest(`${label} looks invalid. ${hint}`);
  return clean;
};

const required = (v: unknown, label: string): string => {
  const s = str(v);
  if (!s) throw new BadRequest(`${label} is required.`);
  return s;
};

const optionalId = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest("Invalid reference.");
  return n;
};

// Ensures a referenced artist/release belongs to the current user.
async function assertOwned(table: typeof artists | typeof releases, id: number | null, ownerId: string) {
  if (id === null) return;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.ownerId, ownerId)));
  if (!row) throw new BadRequest("Referenced item was not found in your catalog.");
}

const parsers = {
  artists: async (b: Fields) => ({
    name: required(b.name, "Artist name"),
    legalName: str(b.legalName),
    ipi: code(b.ipi, "IPI", /^\d{9,11}$/, "IPI name numbers have 9–11 digits."),
    isni: code(b.isni, "ISNI", /^\d{15}[\dX]$/, "ISNIs have 16 characters: 15 digits plus a digit or X."),
    pro: str(b.pro),
    spotifyUrl: str(b.spotifyUrl),
    appleMusicUrl: str(b.appleMusicUrl),
    bio: str(b.bio),
  }),
  releases: async (b: Fields, ownerId: string) => {
    const artistId = optionalId(b.artistId);
    await assertOwned(artists, artistId, ownerId);
    const releaseType = str(b.releaseType) ?? "single";
    if (!["single", "ep", "album", "compilation"].includes(releaseType)) throw new BadRequest("Unknown release type.");
    const releaseDate = str(b.releaseDate);
    if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new BadRequest("Release date must be YYYY-MM-DD.");
    return {
      title: required(b.title, "Release title"),
      artistId,
      releaseType,
      upc: code(b.upc, "UPC/EAN", /^\d{12,13}$/, "UPCs have 12 digits; EANs have 13."),
      label: str(b.label),
      releaseDate,
    };
  },
  tracks: async (b: Fields, ownerId: string) => {
    const artistId = optionalId(b.artistId);
    const releaseId = optionalId(b.releaseId);
    await assertOwned(artists, artistId, ownerId);
    await assertOwned(releases, releaseId, ownerId);
    const duration = str(b.durationSeconds);
    const durationSeconds = duration === null ? null : Number(duration);
    if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 0))
      throw new BadRequest("Duration must be a whole number of seconds.");
    return {
      title: required(b.title, "Track title"),
      artistId,
      releaseId,
      isrc: code(b.isrc, "ISRC", /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/, "Format: CC-XXX-YY-NNNNN (e.g. US-S1Z-24-00001)."),
      iswc: code(b.iswc, "ISWC", /^T\d{10}$/, "Format: T-123.456.789-0."),
      durationSeconds,
      genre: str(b.genre),
      writers: str(b.writers),
      explicit: b.explicit === true || b.explicit === "true" || b.explicit === "on",
    };
  },
};

const tables = { artists, releases, tracks };
type Resource = keyof typeof tables;

export default async (req: Request, context: Context) => {
  const user = await getUser();
  if (!user) return Response.json({ error: "Please log in." }, { status: 401 });

  const resource = context.params.resource as Resource;
  const table = tables[resource];
  if (!table) return Response.json({ error: "Not found" }, { status: 404 });

  const ownerId = user.id;
  const id = context.params.id ? Number(context.params.id) : null;
  if (id !== null && !Number.isInteger(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const owned = (rowId: number) => and(eq(table.id, rowId), eq(table.ownerId, ownerId));

  try {
    if (req.method === "GET" && id === null) {
      const rows = await db.select().from(table).where(eq(table.ownerId, ownerId)).orderBy(desc(table.createdAt));
      return Response.json(rows, { headers: { "Cache-Control": "private, no-store" } });
    }

    // Writes rely on the session cookie, so reject cross-site requests.
    if (req.method !== "GET") verifyRequestOrigin(req);

    if (req.method === "POST" && id === null) {
      const values = await parsers[resource]((await req.json()) as Fields, ownerId);
      const [row] = await db.insert(table).values({ ...values, ownerId } as never).returning();
      return Response.json(row, { status: 201 });
    }

    if (req.method === "PUT" && id !== null) {
      const values = await parsers[resource]((await req.json()) as Fields, ownerId);
      const [row] = await db.update(table).set(values as never).where(owned(id)).returning();
      if (!row) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(row);
    }

    if (req.method === "DELETE" && id !== null) {
      const [row] = await db.delete(table).where(owned(id)).returning({ id: table.id });
      if (!row) return Response.json({ error: "Not found" }, { status: 404 });
      return new Response(null, { status: 204 });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  } catch (error) {
    if (error instanceof BadRequest) return Response.json({ error: error.message }, { status: 400 });
    if (error instanceof AuthError) return Response.json({ error: "Request blocked." }, { status: error.status ?? 403 });
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    throw error;
  }
};

export const config: Config = {
  path: ["/api/:resource", "/api/:resource/:id"],
};
