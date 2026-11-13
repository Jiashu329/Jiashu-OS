import imageManifest from '../data/food-catalog-images.json' with { type: 'json' };

export interface FoodCatalogImage { readonly src: string; readonly alt: string }

// Visual metadata is independent from immutable nutrition records and snapshots.
// The official product can have several serving specifications with one photo.
const images = new Map<string, FoodCatalogImage>();
for (const product of imageManifest.images) {
  const image = Object.freeze({ src: product.src, alt: product.productTitle });
  for (const foodId of product.foodIds) images.set(foodId, image);
}

/** Return only the images for this bounded response, without altering foods. */
export function foodCatalogImages(foods: readonly { id: string }[]): Record<string, FoodCatalogImage> {
  const result: Record<string, FoodCatalogImage> = {};
  for (const food of foods) {
    const image = images.get(food.id);
    if (image) result[food.id] = image;
  }
  return result;
}
