// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

// Deploy defaults target this repo's GitHub Pages project URL
// (https://danielscholl.github.io/keelson-rib-osdu/). For a custom domain, set
// base to "/" and add a CNAME.
export default defineConfig({
  site: "https://danielscholl.github.io",
  base: "/keelson-rib-osdu",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Keelson Rib · OSDU",
      description:
        "The OSDU CIMPL bridge as a Keelson rib: live cluster/Flux topology and platform-health lanes.",
      favicon: "/assets/keelson-mark.svg",
      customCss: ["./src/styles/keelson-theme.css"],
      // Emits /llms.txt, /llms-full.txt, /llms-small.txt at build (llmstxt.org).
      plugins: [
        starlightLlmsTxt({
          projectName: "Keelson Rib · OSDU",
          description:
            "A Keelson rib that bridges OSDU CIMPL: deterministic collector workflows whose structured output drives live canvas views.",
        }),
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/danielscholl/keelson-rib-osdu",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
      ],
    }),
  ],
});
