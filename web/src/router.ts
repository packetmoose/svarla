import { h, Component, ComponentType } from "preact";

/**
 * Simple hash-based client-side router.
 * Listens to hashchange events and renders the appropriate component.
 */

export interface Route {
  path: string;
  component: ComponentType;
}

let routes: Route[] = [];
let notFoundComponent: ComponentType = () => h("div", null, "Not Found");

export function registerRoutes(
  routeDefs: Route[],
  notFound?: ComponentType
): void {
  routes = routeDefs;
  if (notFound) {
    notFoundComponent = notFound;
  }
}

export function navigate(path: string): void {
  window.location.hash = `#${path}`;
}

function getCurrentPath(): string {
  const hash = window.location.hash;
  if (!hash) return "/";
  const path = hash.slice(1);
  // Strip query parameters for route matching
  const queryIndex = path.indexOf("?");
  return queryIndex !== -1 ? path.slice(0, queryIndex) : path;
}

function matchRoute(path: string): Route | undefined {
  return routes.find((route) => {
    if (route.path === path) return true;
    // Simple wildcard support for nested paths
    if (route.path.endsWith("/*")) {
      const prefix = route.path.slice(0, -2);
      return path.startsWith(prefix);
    }
    return false;
  });
}

interface RouterState {
  path: string;
}

export class Router extends Component<Record<string, never>, RouterState> {
  constructor(props: Record<string, never>) {
    super(props);
    this.state = { path: getCurrentPath() };
  }

  componentDidMount() {
    window.addEventListener("hashchange", this.handleHashChange);
  }

  componentWillUnmount() {
    window.removeEventListener("hashchange", this.handleHashChange);
  }

  handleHashChange = () => {
    this.setState({ path: getCurrentPath() });
  };

  render() {
    const matched = matchRoute(this.state.path);
    const Comp = matched ? matched.component : notFoundComponent;
    return h(Comp, null);
  }
}
