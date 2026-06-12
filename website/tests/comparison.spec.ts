import { expect, test } from "./helpers";

test.describe("Comparison widget", () => {
  test("renders the section with Pluks and all five competitors", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("#compare");
    await expect(section).toBeVisible();
    await expect(section.locator(".section-title")).toContainText(/stacks up/i);

    const headerRow = section.locator("thead tr th");
    // 1 factor column + Pluks + 5 competitors
    await expect(headerRow).toHaveCount(7);
    for (const name of ["pluks", "Maccy", "Paste", "Raycast", "CopyQ", "Ditto"]) {
      await expect(section.locator("thead")).toContainText(name);
    }
  });

  test("compares factors but not installs/downloads", async ({ page }) => {
    await page.goto("/");
    const table = page.locator("#compare .compare-table");
    await expect(table.locator("tbody tr")).toHaveCount(10);
    await expect(table).toContainText("Copies the moment you select");
    await expect(table).toContainText("Price");
    await expect(table).toContainText("Open source");
    await expect(table).not.toContainText(/installs|downloads/i);
  });

  test("Pluks column is highlighted in every row", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator("#compare .compare-table tbody tr");
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      await expect(rows.nth(i).locator("td.col-pluks")).toHaveCount(1);
    }
  });

  test("competitor names link out to their sites", async ({ page }) => {
    await page.goto("/");
    const links = page.locator("#compare thead a");
    await expect(links).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      await expect(links.nth(i)).toHaveAttribute("href", /^https:\/\//);
      await expect(links.nth(i)).toHaveAttribute("rel", "noopener");
    }
  });
});
