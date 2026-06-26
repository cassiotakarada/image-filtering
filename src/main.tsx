import { createRoot } from "react-dom/client";
import App from "./App";

// NOTE: intentionally no StrictMode — its dev double-invoke of effects would
// create two Babylon workers and enable the Cornerstone element twice. Fine to
// omit for a throwaway spike.
createRoot(document.getElementById("root")!).render(<App />);
