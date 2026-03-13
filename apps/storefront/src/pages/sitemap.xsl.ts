/**
 * XSL Stylesheet for Sitemap Visualization
 * Premium design matching Scalius Lite Storefront Builder aesthetic
 */

import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async () => {
  const xsl = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
  xmlns:html="http://www.w3.org/1999/xhtml"
  xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html xmlns="http://www.w3.org/1999/xhtml" lang="en">
      <head>
        <title>XML Sitemap</title>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap" rel="stylesheet" />

        <style>
          :root {
            --bg-page: #F8FAFC;
            --bg-card: #FFFFFF;
            --bg-accent: #F1F5F9;

            --text-primary: #0F172A;
            --text-secondary: #64748B;
            --text-tertiary: #94A3B8;

            --primary-brand: #3B82F6;
            --primary-glow: rgba(59, 130, 246, 0.15);

            --border-subtle: #E2E8F0;

            --success-text: #059669;
            --success-bg: #DCFCE7;

            --max-w: 850px;
            --radius-outer: 16px;
            --radius-inner: 8px;
          }

          * { box-sizing: border-box; margin: 0; padding: 0; }

          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background-color: var(--bg-page);
            color: var(--text-primary);
            -webkit-font-smoothing: antialiased;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
          }

          .bg-decoration {
            position: fixed;
            top: -100px;
            left: 50%;
            transform: translateX(-50%);
            width: 600px;
            height: 600px;
            background: radial-gradient(circle, rgba(59,130,246,0.08) 0%, rgba(255,255,255,0) 70%);
            z-index: -1;
            pointer-events: none;
          }

          .wrapper {
            width: 100%;
            max-width: var(--max-w);
            animation: fadeIn 0.6s ease-out;
          }

          header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 24px;
            padding: 0 4px;
          }

          .brand-area h1 {
            font-size: 24px;
            font-weight: 700;
            color: var(--text-primary);
            letter-spacing: -0.03em;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
          }

          .brand-area p {
            color: var(--text-secondary);
            font-size: 14px;
          }

          .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--success-bg);
            color: var(--success-text);
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.02em;
            text-transform: uppercase;
          }

          .pulse-dot {
            width: 8px;
            height: 8px;
            background-color: var(--success-text);
            border-radius: 50%;
            position: relative;
          }

          .pulse-dot::after {
            content: '';
            position: absolute;
            top: -2px; left: -2px; right: -2px; bottom: -2px;
            border-radius: 50%;
            border: 2px solid var(--success-text);
            opacity: 0;
            animation: pulse 2s infinite;
          }

          @keyframes pulse {
            0% { transform: scale(1); opacity: 0.8; }
            100% { transform: scale(2.5); opacity: 0; }
          }

          .btn-copy {
            background: white;
            border: 1px solid var(--border-subtle);
            color: var(--text-secondary);
            padding: 10px 16px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
          }

          .btn-copy:hover {
            border-color: var(--primary-brand);
            color: var(--primary-brand);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px var(--primary-glow);
          }

          .card {
            background: var(--bg-card);
            border-radius: var(--radius-outer);
            box-shadow:
              0 0 0 1px rgba(0,0,0,0.03),
              0 20px 25px -5px rgba(0, 0, 0, 0.05),
              0 8px 10px -6px rgba(0, 0, 0, 0.01);
            overflow: hidden;
          }

          table {
            width: 100%;
            border-collapse: collapse;
          }

          th {
            text-align: left;
            padding: 14px 24px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--text-tertiary);
            background: #FAFAFA;
            border-bottom: 1px solid var(--border-subtle);
          }

          td {
            padding: 16px 24px;
            border-bottom: 1px solid var(--border-subtle);
            color: var(--text-secondary);
            font-size: 14px;
            transition: background 0.2s;
          }

          tr:last-child td {
            border-bottom: none;
          }

          tr {
            transition: all 0.2s ease;
          }

          tbody tr:hover td {
            background-color: #F8FAFC;
          }

          .sitemap-link {
            display: flex;
            align-items: center;
            gap: 12px;
            text-decoration: none;
            color: var(--text-primary);
            font-weight: 500;
            font-size: 14px;
          }

          .icon-box {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-accent);
            color: var(--text-secondary);
            border-radius: 8px;
            transition: all 0.2s;
            flex-shrink: 0;
          }

          .icon-box svg {
            width: 18px;
            height: 18px;
          }

          tr:hover .icon-box {
            background: var(--primary-brand);
            color: white;
          }

          tr:hover .sitemap-link span {
            color: var(--primary-brand);
          }

          .badge {
            background: var(--bg-accent);
            color: var(--text-secondary);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            font-variant-numeric: tabular-nums;
          }

          .footer {
            margin-top: 32px;
            text-align: center;
            font-size: 13px;
            color: var(--text-tertiary);
          }

          .footer a {
            color: var(--primary-brand);
            text-decoration: none;
            font-weight: 500;
            transition: color 0.2s;
            border-bottom: 1px dotted var(--primary-brand);
          }

          .footer a:hover {
            color: var(--text-primary);
            border-bottom-style: solid;
          }

          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }

          @media (max-width: 640px) {
            body { padding: 24px 16px; }
            header { flex-direction: column; align-items: flex-start; gap: 16px; }
            th:nth-child(3), td:nth-child(3) { display: none; }
            td, th { padding: 12px 16px; }
            .brand-area h1 { font-size: 20px; }
            .btn-copy { width: 100%; justify-content: center; }
          }
        </style>
      </head>
      <body>
        <div class="bg-decoration"></div>
        <div class="wrapper">
          <xsl:apply-templates/>
        </div>

        <script>
          function copyUrl() {
            const btn = document.querySelector('.btn-copy');
            const originalContent = btn.innerHTML;

            const dummy = document.createElement('input');
            document.body.appendChild(dummy);
            dummy.value = window.location.href;
            dummy.select();
            document.execCommand('copy');
            document.body.removeChild(dummy);

            btn.innerHTML = \`&lt;svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"&gt;&lt;polyline points="20 6 9 17 4 12"&gt;&lt;/polyline&gt;&lt;/svg&gt; &lt;span style="color:#059669"&gt;Copied!&lt;/span&gt;\`;
            btn.style.borderColor = "#059669";

            setTimeout(() => {
              btn.innerHTML = originalContent;
              btn.style.borderColor = "";
            }, 2000);
          }
        </script>
      </body>
    </html>
  </xsl:template>

  <xsl:template match="sitemap:sitemapindex">
    <header>
      <div class="brand-area">
        <h1>
          XML Sitemap
          <div class="status-pill"><div class="pulse-dot"></div> Healthy</div>
        </h1>
        <p>Index of all content available for crawling.</p>
      </div>

      <button class="btn-copy" onclick="copyUrl()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy Index URL
      </button>
    </header>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th style="width: 50%;">Sitemap</th>
            <th style="width: 20%;">Type</th>
            <th style="width: 30%; text-align: right;">Last Updated</th>
          </tr>
        </thead>
        <tbody>
          <xsl:for-each select="sitemap:sitemap">
            <tr>
              <td>
                <a class="sitemap-link">
                  <xsl:attribute name="href">
                    <xsl:value-of select="sitemap:loc"/>
                  </xsl:attribute>
                  <div class="icon-box">
                    <xsl:choose>
                      <xsl:when test="contains(sitemap:loc, 'product')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="9" cy="21" r="1"></circle>
                          <circle cx="20" cy="21" r="1"></circle>
                          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
                        </svg>
                      </xsl:when>
                      <xsl:when test="contains(sitemap:loc, 'categor')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="8" y1="6" x2="21" y2="6"></line>
                          <line x1="8" y1="12" x2="21" y2="12"></line>
                          <line x1="8" y1="18" x2="21" y2="18"></line>
                          <line x1="3" y1="6" x2="3.01" y2="6"></line>
                          <line x1="3" y1="12" x2="3.01" y2="12"></line>
                          <line x1="3" y1="18" x2="3.01" y2="18"></line>
                        </svg>
                      </xsl:when>
                      <xsl:when test="contains(sitemap:loc, 'page')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <line x1="3" y1="9" x2="21" y2="9"></line>
                          <line x1="9" y1="21" x2="9" y2="9"></line>
                        </svg>
                      </xsl:when>
                      <xsl:when test="contains(sitemap:loc, 'facebook-feed')">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"></path>
                        </svg>
                      </xsl:when>
                      <xsl:otherwise>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                          <polyline points="14 2 14 8 20 8"></polyline>
                          <line x1="16" y1="13" x2="8" y2="13"></line>
                          <line x1="16" y1="17" x2="8" y2="17"></line>
                          <polyline points="10 9 9 9 8 9"></polyline>
                        </svg>
                      </xsl:otherwise>
                    </xsl:choose>
                  </div>
                  <span>
                    <xsl:variable name="loc" select="sitemap:loc"/>
                    <xsl:value-of select="substring-after($loc, substring($loc, 1, string-length($loc) - string-length(substring-after($loc, '/'))))"/>
                  </span>
                </a>
              </td>
              <td>
                <span class="badge">
                  <xsl:choose>
                    <xsl:when test="contains(sitemap:loc, 'facebook-feed')">Feed</xsl:when>
                    <xsl:otherwise>Sitemap</xsl:otherwise>
                  </xsl:choose>
                </span>
              </td>
              <td style="text-align: right;">
                <xsl:value-of select="concat(substring(sitemap:lastmod, 9, 2), ' ', substring(sitemap:lastmod, 6, 2), ' ', substring(sitemap:lastmod, 1, 4))"/>
              </td>
            </tr>
          </xsl:for-each>
        </tbody>
      </table>
    </div>

    <div class="footer">
      Generated by <a href="https://scalius.com/commerce-lite" target="_blank" rel="noopener noreferrer">Scalius Lite Storefront Builder</a>
    </div>
  </xsl:template>

  <xsl:template match="sitemap:urlset">
    <header>
      <div class="brand-area">
        <h1>
          XML Sitemap
          <div class="status-pill"><div class="pulse-dot"></div> Healthy</div>
        </h1>
        <p>List of <strong><xsl:value-of select="count(sitemap:url)"/> URLs</strong> available for crawling.</p>
      </div>

      <button class="btn-copy" onclick="copyUrl()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy URL
      </button>
    </header>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th style="width: 50%;">URL</th>
            <th style="width: 15%;">Priority</th>
            <th style="width: 15%;">Change Freq</th>
            <th style="width: 20%; text-align: right;">Last Modified</th>
          </tr>
        </thead>
        <tbody>
          <xsl:for-each select="sitemap:url">
            <tr>
              <td>
                <a class="sitemap-link">
                  <xsl:attribute name="href">
                    <xsl:value-of select="sitemap:loc"/>
                  </xsl:attribute>
                  <div class="icon-box">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                    </svg>
                  </div>
                  <span style="word-break: break-all;">
                    <xsl:value-of select="sitemap:loc"/>
                  </span>
                </a>
              </td>
              <td>
                <span class="badge">
                  <xsl:value-of select="sitemap:priority"/>
                </span>
              </td>
              <td><xsl:value-of select="sitemap:changefreq"/></td>
              <td style="text-align: right;">
                <xsl:value-of select="concat(substring(sitemap:lastmod, 9, 2), ' ', substring(sitemap:lastmod, 6, 2), ' ', substring(sitemap:lastmod, 1, 4))"/>
              </td>
            </tr>
          </xsl:for-each>
        </tbody>
      </table>
    </div>

    <div class="footer">
      Generated by <a href="https://scalius.com/commerce-lite" target="_blank" rel="noopener noreferrer">Scalius Lite Storefront Builder</a>
    </div>
  </xsl:template>
</xsl:stylesheet>`;

  return new Response(xsl, {
    status: 200,
    headers: {
      'Content-Type': 'application/xslt+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
};
