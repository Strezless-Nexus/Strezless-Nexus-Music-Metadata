import { pgTable, serial, text, timestamp, integer, boolean, date, index } from "drizzle-orm/pg-core";

// Every row carries the Netlify Identity user id of its owner so each artist only sees their own catalog.

export const artists = pgTable(
  "artists",
  {
    id: serial().primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text().notNull(),
    legalName: text("legal_name"),
    ipi: text(),
    isni: text(),
    pro: text(),
    spotifyUrl: text("spotify_url"),
    appleMusicUrl: text("apple_music_url"),
    bio: text(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("artists_owner_idx").on(t.ownerId)],
);

export const releases = pgTable(
  "releases",
  {
    id: serial().primaryKey(),
    ownerId: text("owner_id").notNull(),
    artistId: integer("artist_id").references(() => artists.id, { onDelete: "set null" }),
    title: text().notNull(),
    releaseType: text("release_type").notNull().default("single"),
    upc: text(),
    label: text(),
    releaseDate: date("release_date"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("releases_owner_idx").on(t.ownerId)],
);

export const tracks = pgTable(
  "tracks",
  {
    id: serial().primaryKey(),
    ownerId: text("owner_id").notNull(),
    artistId: integer("artist_id").references(() => artists.id, { onDelete: "set null" }),
    releaseId: integer("release_id").references(() => releases.id, { onDelete: "set null" }),
    title: text().notNull(),
    isrc: text(),
    iswc: text(),
    durationSeconds: integer("duration_seconds"),
    genre: text(),
    writers: text(),
    explicit: boolean().notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("tracks_owner_idx").on(t.ownerId)],
);
