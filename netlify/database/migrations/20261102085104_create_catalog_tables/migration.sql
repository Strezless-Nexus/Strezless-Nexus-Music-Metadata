CREATE TABLE "artists" (
	"id" serial PRIMARY KEY,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"ipi" text,
	"isni" text,
	"pro" text,
	"spotify_url" text,
	"apple_music_url" text,
	"bio" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" serial PRIMARY KEY,
	"owner_id" text NOT NULL,
	"artist_id" integer,
	"title" text NOT NULL,
	"release_type" text DEFAULT 'single' NOT NULL,
	"upc" text,
	"label" text,
	"release_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" serial PRIMARY KEY,
	"owner_id" text NOT NULL,
	"artist_id" integer,
	"release_id" integer,
	"title" text NOT NULL,
	"isrc" text,
	"iswc" text,
	"duration_seconds" integer,
	"genre" text,
	"writers" text,
	"explicit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "artists_owner_idx" ON "artists" ("owner_id");--> statement-breakpoint
CREATE INDEX "releases_owner_idx" ON "releases" ("owner_id");--> statement-breakpoint
CREATE INDEX "tracks_owner_idx" ON "tracks" ("owner_id");--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_release_id_releases_id_fkey" FOREIGN KEY ("release_id") REFERENCES "releases"("id") ON DELETE SET NULL;