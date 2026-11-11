// Navigation state of a small project browser: a list page with a search box, and project pages.
export function createNav() {
  const stack = [];
  let view = { page: "list", search: "" };
  return {
    get view() {
      return { ...view };
    },
    setSearch(text) {
      view = { ...view, search: text };
    },
    openProject(id) {
      stack.push(view);
      view = { page: "project", id, search: "" };
    },
    goBack() {
      const previous = stack.pop();
      view = previous ? { ...previous, search: "" } : view;
    },
  };
}
