// Pure helpers over Storybook's index, kept apart from the Playwright fixtures so a unit test
// can import them without starting Playwright.
export interface IndexRecord {
  id: string;
  type: string;
  title: string;
}

// A docs page shows one story block for each story with its title.
export const storiesOnPage = (entries: readonly IndexRecord[], title: string): number =>
  entries.filter((entry) => entry.type === 'story' && entry.title === title).length;
