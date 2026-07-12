import type { Database } from "@scalius/database/client";
import { heroSliders } from "@scalius/database/schema";
import {
  validateAndNormalizeHeroSlides,
  type HeroSlide,
} from "@scalius/shared/hero-slider";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../errors";

export type HeroSliderType = "desktop" | "mobile";

export interface HeroSliderRecord {
  id: string;
  type: HeroSliderType;
  images: HeroSlide[];
  isActive: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateHeroSliderInput {
  type: HeroSliderType;
  images: unknown;
  isActive?: boolean;
}

export interface UpdateHeroSliderInput {
  expectedRevision: number;
  images?: unknown;
  isActive?: boolean;
}

export class HeroSliderRevisionConflictError extends AppError {
  constructor(id: string, expectedRevision: number, currentRevision: number) {
    super(
      409,
      "HERO_SLIDER_REVISION_CONFLICT",
      "This hero slider changed in another session. Your draft is still available; load the latest saved version before trying again.",
      { id, expectedRevision, currentRevision },
    );
    this.name = "HeroSliderRevisionConflictError";
  }
}

function normalizeSlides(images: unknown): HeroSlide[] {
  const result = validateAndNormalizeHeroSlides(images);
  if (!result.ok) {
    throw new ValidationError("Hero slides need attention before saving.", {
      issues: result.errors,
    });
  }
  return result.slides;
}

function assertActiveHasSlides(isActive: boolean, images: readonly HeroSlide[]): void {
  if (isActive && images.length === 0) {
    throw new ValidationError(
      "Add at least one slide before showing this hero slider on the storefront.",
    );
  }
}

function parseStoredSlider(
  slider: typeof heroSliders.$inferSelect,
): HeroSliderRecord {
  let storedImages: unknown;
  try {
    storedImages = JSON.parse(slider.images);
  } catch {
    throw new ValidationError(
      "This saved hero slider is malformed. Repair its slides before publishing.",
    );
  }
  const images = normalizeSlides(storedImages);
  assertActiveHasSlides(slider.isActive, images);
  return { ...slider, images };
}

function isActiveTypeUniqueConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /hero_sliders_active_type_unique|unique constraint.*hero_sliders\.type/i.test(
    message,
  );
}

export async function listHeroSliders(db: Database): Promise<HeroSliderRecord[]> {
  const rows = await db
    .select()
    .from(heroSliders)
    .where(isNull(heroSliders.deletedAt))
    .orderBy(heroSliders.type);
  return rows.map(parseStoredSlider);
}

export async function getHeroSlider(
  db: Database,
  id: string,
): Promise<HeroSliderRecord> {
  const slider = await db
    .select()
    .from(heroSliders)
    .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
    .get();
  if (!slider) throw new NotFoundError("Hero slider not found");
  return parseStoredSlider(slider);
}

export async function createHeroSlider(
  db: Database,
  input: CreateHeroSliderInput,
): Promise<HeroSliderRecord> {
  const images = normalizeSlides(input.images);
  const isActive = input.isActive ?? false;
  assertActiveHasSlides(isActive, images);

  const existing = await db
    .select({ id: heroSliders.id })
    .from(heroSliders)
    .where(and(eq(heroSliders.type, input.type), isNull(heroSliders.deletedAt)))
    .get();
  if (existing) {
    throw new ConflictError(`A ${input.type} hero slider already exists.`);
  }

  try {
    const [slider] = await db
      .insert(heroSliders)
      .values({
        id: `slider_${nanoid()}`,
        type: input.type,
        images: JSON.stringify(images),
        isActive,
        revision: 1,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();
    if (!slider) throw new ValidationError("Hero slider could not be created.");
    return parseStoredSlider(slider);
  } catch (error) {
    if (isActiveTypeUniqueConflict(error)) {
      throw new ConflictError(`A ${input.type} hero slider already exists.`);
    }
    throw error;
  }
}

export async function updateHeroSlider(
  db: Database,
  id: string,
  input: UpdateHeroSliderInput,
): Promise<HeroSliderRecord> {
  const current = await getHeroSlider(db, id);
  const images = input.images === undefined
    ? current.images
    : normalizeSlides(input.images);
  const isActive = input.isActive ?? current.isActive;
  assertActiveHasSlides(isActive, images);

  const [updated] = await db
    .update(heroSliders)
    .set({
      ...(input.images === undefined ? {} : { images: JSON.stringify(images) }),
      ...(input.isActive === undefined ? {} : { isActive }),
      revision: sql`${heroSliders.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(heroSliders.id, id),
        eq(heroSliders.revision, input.expectedRevision),
        isNull(heroSliders.deletedAt),
      ),
    )
    .returning();

  if (updated) return parseStoredSlider(updated);

  const latest = await db
    .select({ revision: heroSliders.revision })
    .from(heroSliders)
    .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
    .get();
  if (!latest) throw new NotFoundError("Hero slider not found");
  throw new HeroSliderRevisionConflictError(
    id,
    input.expectedRevision,
    latest.revision,
  );
}

export async function deleteHeroSlider(
  db: Database,
  id: string,
  expectedRevision: number,
): Promise<HeroSliderRecord> {
  const [deleted] = await db
    .update(heroSliders)
    .set({
      isActive: false,
      deletedAt: sql`unixepoch()`,
      revision: sql`${heroSliders.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(
      and(
        eq(heroSliders.id, id),
        eq(heroSliders.revision, expectedRevision),
        isNull(heroSliders.deletedAt),
      ),
    )
    .returning();

  if (deleted) return parseStoredSlider(deleted);

  const latest = await db
    .select({ revision: heroSliders.revision })
    .from(heroSliders)
    .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
    .get();
  if (!latest) throw new NotFoundError("Hero slider not found");
  throw new HeroSliderRevisionConflictError(id, expectedRevision, latest.revision);
}
