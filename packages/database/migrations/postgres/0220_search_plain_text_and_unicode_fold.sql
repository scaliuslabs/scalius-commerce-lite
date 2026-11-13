-- PostgreSQL: search reads text, folded as FTS5 folds it (SQLite twin and
-- packages/database/src/search-index.ts). The fold is one function, a
-- translate() of FTS5's whole map (case for every script, where the old
-- translate() covered Latin-1); a rich-text column is read without its markup.
-- Every search trigger function is replaced, then the index rebuilt as the
-- fresh schema builds it (rows first, then each index once).
CREATE OR REPLACE FUNCTION scalius_compat.search_fts_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $search_fold$ SELECT translate(lower(value COLLATE "C"), E'\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f!"#$%&''()*+,-./:;<=>?@[\\]^_`{|}~\u007f\u0080\u0081\u0082\u0083\u0084\u0085\u0086\u0087\u0088\u0089\u008a\u008b\u008c\u008d\u008e\u008f\u0090\u0091\u0092\u0093\u0094\u0095\u0096\u0097\u0098\u0099\u009a\u009b\u009c\u009d\u009e\u009f\u00a0\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b4\u00b6\u00b7\u00b8\u00bb\u00bf\u00d7\u00f7\u02c2\u02c3\u02c4\u02c5\u02d2\u02d3\u02d4\u02d5\u02d6\u02d7\u02d8\u02d9\u02da\u02db\u02dc\u02dd\u02de\u02df\u02e5\u02e6\u02e7\u02e8\u02e9\u02ea\u02eb\u02ed\u02ef\u02f0\u02f1\u02f2\u02f3\u02f4\u02f5\u02f6\u02f7\u02f8\u02f9\u02fa\u02fb\u02fc\u02fd\u02fe\u02ff\u0375\u037e\u0384\u0385\u0387\u03f6\u0482\u0488\u0489\u055a\u055b\u055c\u055d\u055e\u055f\u0589\u058a\u058f\u05be\u05c0\u05c3\u05c6\u05f3\u05f4\u0600\u0601\u0602\u0603\u0604\u0606\u0607\u0608\u0609\u060a\u060b\u060c\u060d\u060e\u060f\u061b\u061e\u061f\u066a\u066b\u066c\u066d\u06d4\u06dd\u06de\u06e9\u06fd\u06fe\u0700\u0701\u0702\u0703\u0704\u0705\u0706\u0707\u0708\u0709\u070a\u070b\u070c\u070d\u070f\u07f6\u07f7\u07f8\u07f9\u0830\u0831\u0832\u0833\u0834\u0835\u0836\u0837\u0838\u0839\u083a\u083b\u083c\u083d\u083e\u085e\u0964\u0965\u0970\u09f2\u09f3\u09fa\u09fb\u0af0\u0af1\u0b70\u0bf3\u0bf4\u0bf5\u0bf6\u0bf7\u0bf8\u0bf9\u0bfa\u0c7f\u0d79\u0df4\u0e3f\u0e4f\u0e5a\u0e5b\u0f01\u0f02\u0f03\u0f04\u0f05\u0f06\u0f07\u0f08\u0f09\u0f0a\u0f0b\u0f0c\u0f0d\u0f0e\u0f0f\u0f10\u0f11\u0f12\u0f13\u0f14\u0f15\u0f16\u0f17\u0f1a\u0f1b\u0f1c\u0f1d\u0f1e\u0f1f\u0f34\u0f36\u0f38\u0f3a\u0f3b\u0f3c\u0f3d\u0f85\u0fbe\u0fbf\u0fc0\u0fc1\u0fc2\u0fc3\u0fc4\u0fc5\u0fc7\u0fc8\u0fc9\u0fca\u0fcb\u0fcc\u0fce\u0fcf\u0fd0\u0fd1\u0fd2\u0fd3\u0fd4\u0fd5\u0fd6\u0fd7\u0fd8\u0fd9\u0fda\u104a\u104b\u104c\u104d\u104e\u104f\u109e\u109f\u10fb\u1360\u1361\u1362\u1363\u1364\u1365\u1366\u1367\u1368\u1390\u1391\u1392\u1393\u1394\u1395\u1396\u1397\u1398\u1399\u1400\u166d\u166e\u1680\u169b\u169c\u16eb\u16ec\u16ed\u1735\u1736\u17d4\u17d5\u17d6\u17d8\u17d9\u17da\u17db\u1800\u1801\u1802\u1803\u1804\u1805\u1806\u1807\u1808\u1809\u180a\u180e\u1940\u1944\u1945\u19de\u19df\u19e0\u19e1\u19e2\u19e3\u19e4\u19e5\u19e6\u19e7\u19e8\u19e9\u19ea\u19eb\u19ec\u19ed\u19ee\u19ef\u19f0\u19f1\u19f2\u19f3\u19f4\u19f5\u19f6\u19f7\u19f8\u19f9\u19fa\u19fb\u19fc\u19fd\u19fe\u19ff\u1a1e\u1a1f\u1aa0\u1aa1\u1aa2\u1aa3\u1aa4\u1aa5\u1aa6\u1aa8\u1aa9\u1aaa\u1aab\u1aac\u1aad\u1b5a\u1b5b\u1b5c\u1b5d\u1b5e\u1b5f\u1b60\u1b61\u1b62\u1b63\u1b64\u1b65\u1b66\u1b67\u1b68\u1b69\u1b6a\u1b74\u1b75\u1b76\u1b77\u1b78\u1b79\u1b7a\u1b7b\u1b7c\u1bfc\u1bfd\u1bfe\u1bff\u1c3b\u1c3c\u1c3d\u1c3e\u1c3f\u1c7e\u1c7f\u1cc0\u1cc1\u1cc2\u1cc3\u1cc4\u1cc5\u1cc6\u1cc7\u1cd3\u1fbd\u1fbf\u1fc0\u1fc1\u1fcd\u1fce\u1fcf\u1fdd\u1fde\u1fdf\u1fed\u1fee\u1fef\u1ffd\u1ffe\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200b\u200c\u200d\u200e\u200f\u2010\u2011\u2012\u2013\u2014\u2015\u2016\u2017\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u2020\u2021\u2022\u2023\u2024\u2025\u2026\u2027\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u202f\u2030\u2031\u2032\u2033\u2034\u2035\u2036\u2037\u2038\u2039\u203a\u203b\u203c\u203d\u203e\u203f\u2040\u2041\u2042\u2043\u2044\u2045\u2046\u2047\u2048\u2049\u204a\u204b\u204c\u204d\u204e\u204f\u2050\u2051\u2052\u2053\u2054\u2055\u2056\u2057\u2058\u2059\u205a\u205b\u205c\u205d\u205e\u205f\u2060\u2061\u2062\u2063\u2064\u206a\u206b\u206c\u206d\u206e\u206f\u207a\u207b\u207c\u207d\u207e\u208a\u208b\u208c\u208d\u208e\u20a0\u20a1\u20a2\u20a3\u20a4\u20a5\u20a6\u20a7\u20a8\u20a9\u20aa\u20ab\u20ac\u20ad\u20ae\u20af\u20b0\u20b1\u20b2\u20b3\u20b4\u20b5\u20b6\u20b7\u20b8\u20b9\u20dd\u20de\u20df\u20e0\u20e2\u20e3\u20e4\u2100\u2101\u2103\u2104\u2105\u2106\u2108\u2109\u2114\u2116\u2117\u2118\u211e\u211f\u2120\u2121\u2122\u2123\u2125\u2127\u2129\u212e\u213a\u213b\u2140\u2141\u2142\u2143\u2144\u214a\u214b\u214c\u214d\u214f\u2190\u2191\u2192\u2193\u2194\u2195\u2196\u2197\u2198\u2199\u219a\u219b\u219c\u219d\u219e\u219f\u21a0\u21a1\u21a2\u21a3\u21a4\u21a5\u21a6\u21a7\u21a8\u21a9\u21aa\u21ab\u21ac\u21ad\u21ae\u21af\u21b0\u21b1\u21b2\u21b3\u21b4\u21b5\u21b6\u21b7\u21b8\u21b9\u21ba\u21bb\u21bc\u21bd\u21be\u21bf\u21c0\u21c1\u21c2\u21c3\u21c4\u21c5\u21c6\u21c7\u21c8\u21c9\u21ca\u21cb\u21cc\u21cd\u21ce\u21cf\u21d0\u21d1\u21d2\u21d3\u21d4\u21d5\u21d6\u21d7\u21d8\u21d9\u21da\u21db\u21dc\u21dd\u21de\u21df\u21e0\u21e1\u21e2\u21e3\u21e4\u21e5\u21e6\u21e7\u21e8\u21e9\u21ea\u21eb\u21ec\u21ed\u21ee\u21ef\u21f0\u21f1\u21f2\u21f3\u21f4\u21f5\u21f6\u21f7\u21f8\u21f9\u21fa\u21fb\u21fc\u21fd\u21fe\u21ff\u2200\u2201\u2202\u2203\u2204\u2205\u2206\u2207\u2208\u2209\u220a\u220b\u220c\u220d\u220e\u220f\u2210\u2211\u2212\u2213\u2214\u2215\u2216\u2217\u2218\u2219\u221a\u221b\u221c\u221d\u221e\u221f\u2220\u2221\u2222\u2223\u2224\u2225\u2226\u2227\u2228\u2229\u222a\u222b\u222c\u222d\u222e\u222f\u2230\u2231\u2232\u2233\u2234\u2235\u2236\u2237\u2238\u2239\u223a\u223b\u223c\u223d\u223e\u223f\u2240\u2241\u2242\u2243\u2244\u2245\u2246\u2247\u2248\u2249\u224a\u224b\u224c\u224d\u224e\u224f\u2250\u2251\u2252\u2253\u2254\u2255\u2256\u2257\u2258\u2259\u225a\u225b\u225c\u225d\u225e\u225f\u2260\u2261\u2262\u2263\u2264\u2265\u2266\u2267\u2268\u2269\u226a\u226b\u226c\u226d\u226e\u226f\u2270\u2271\u2272\u2273\u2274\u2275\u2276\u2277\u2278\u2279\u227a\u227b\u227c\u227d\u227e\u227f\u2280\u2281\u2282\u2283\u2284\u2285\u2286\u2287\u2288\u2289\u228a\u228b\u228c\u228d\u228e\u228f\u2290\u2291\u2292\u2293\u2294\u2295\u2296\u2297\u2298\u2299\u229a\u229b\u229c\u229d\u229e\u229f\u22a0\u22a1\u22a2\u22a3\u22a4\u22a5\u22a6\u22a7\u22a8\u22a9\u22aa\u22ab\u22ac\u22ad\u22ae\u22af\u22b0\u22b1\u22b2\u22b3\u22b4\u22b5\u22b6\u22b7\u22b8\u22b9\u22ba\u22bb\u22bc\u22bd\u22be\u22bf\u22c0\u22c1\u22c2\u22c3\u22c4\u22c5\u22c6\u22c7\u22c8\u22c9\u22ca\u22cb\u22cc\u22cd\u22ce\u22cf\u22d0\u22d1\u22d2\u22d3\u22d4\u22d5\u22d6\u22d7\u22d8\u22d9\u22da\u22db\u22dc\u22dd\u22de\u22df\u22e0\u22e1\u22e2\u22e3\u22e4\u22e5\u22e6\u22e7\u22e8\u22e9\u22ea\u22eb\u22ec\u22ed\u22ee\u22ef\u22f0\u22f1\u22f2\u22f3\u22f4\u22f5\u22f6\u22f7\u22f8\u22f9\u22fa\u22fb\u22fc\u22fd\u22fe\u22ff\u2300\u2301\u2302\u2303\u2304\u2305\u2306\u2307\u2308\u2309\u230a\u230b\u230c\u230d\u230e\u230f\u2310\u2311\u2312\u2313\u2314\u2315\u2316\u2317\u2318\u2319\u231a\u231b\u231c\u231d\u231e\u231f\u2320\u2321\u2322\u2323\u2324\u2325\u2326\u2327\u2328\u2329\u232a\u232b\u232c\u232d\u232e\u232f\u2330\u2331\u2332\u2333\u2334\u2335\u2336\u2337\u2338\u2339\u233a\u233b\u233c\u233d\u233e\u233f\u2340\u2341\u2342\u2343\u2344\u2345\u2346\u2347\u2348\u2349\u234a\u234b\u234c\u234d\u234e\u234f\u2350\u2351\u2352\u2353\u2354\u2355\u2356\u2357\u2358\u2359\u235a\u235b\u235c\u235d\u235e\u235f\u2360\u2361\u2362\u2363\u2364\u2365\u2366\u2367\u2368\u2369\u236a\u236b\u236c\u236d\u236e\u236f\u2370\u2371\u2372\u2373\u2374\u2375\u2376\u2377\u2378\u2379\u237a\u237b\u237c\u237d\u237e\u237f\u2380\u2381\u2382\u2383\u2384\u2385\u2386\u2387\u2388\u2389\u238a\u238b\u238c\u238d\u238e\u238f\u2390\u2391\u2392\u2393\u2394\u2395\u2396\u2397\u2398\u2399\u239a\u239b\u239c\u239d\u239e\u239f\u23a0\u23a1\u23a2\u23a3\u23a4\u23a5\u23a6\u23a7\u23a8\u23a9\u23aa\u23ab\u23ac\u23ad\u23ae\u23af\u23b0\u23b1\u23b2\u23b3\u23b4\u23b5\u23b6\u23b7\u23b8\u23b9\u23ba\u23bb\u23bc\u23bd\u23be\u23bf\u23c0\u23c1\u23c2\u23c3\u23c4\u23c5\u23c6\u23c7\u23c8\u23c9\u23ca\u23cb\u23cc\u23cd\u23ce\u23cf\u23d0\u23d1\u23d2\u23d3\u23d4\u23d5\u23d6\u23d7\u23d8\u23d9\u23da\u23db\u23dc\u23dd\u23de\u23df\u23e0\u23e1\u23e2\u23e3\u23e4\u23e5\u23e6\u23e7\u23e8\u23e9\u23ea\u23eb\u23ec\u23ed\u23ee\u23ef\u23f0\u23f1\u23f2\u23f3\u2400\u2401\u2402\u2403\u2404\u2405\u2406\u2407\u2408\u2409\u240a\u240b\u240c\u240d\u240e\u240f\u2410\u2411\u2412\u2413\u2414\u2415\u2416\u2417\u2418\u2419\u241a\u241b\u241c\u241d\u241e\u241f\u2420\u2421\u2422\u2423\u2424\u2425\u2426\u2440\u2441\u2442\u2443\u2444\u2445\u2446\u2447\u2448\u2449\u244a\u249c\u249d\u249e\u249f\u24a0\u24a1\u24a2\u24a3\u24a4\u24a5\u24a6\u24a7\u24a8\u24a9\u24aa\u24ab\u24ac\u24ad\u24ae\u24af\u24b0\u24b1\u24b2\u24b3\u24b4\u24b5\u24b6\u24b7\u24b8\u24b9\u24ba\u24bb\u24bc\u24bd\u24be\u24bf\u24c0\u24c1\u24c2\u24c3\u24c4\u24c5\u24c6\u24c7\u24c8\u24c9\u24ca\u24cb\u24cc\u24cd\u24ce\u24cf\u24d0\u24d1\u24d2\u24d3\u24d4\u24d5\u24d6\u24d7\u24d8\u24d9\u24da\u24db\u24dc\u24dd\u24de\u24df\u24e0\u24e1\u24e2\u24e3\u24e4\u24e5\u24e6\u24e7\u24e8\u24e9\u2500\u2501\u2502\u2503\u2504\u2505\u2506\u2507\u2508\u2509\u250a\u250b\u250c\u250d\u250e\u250f\u2510\u2511\u2512\u2513\u2514\u2515\u2516\u2517\u2518\u2519\u251a\u251b\u251c\u251d\u251e\u251f\u2520\u2521\u2522\u2523\u2524\u2525\u2526\u2527\u2528\u2529\u252a\u252b\u252c\u252d\u252e\u252f\u2530\u2531\u2532\u2533\u2534\u2535\u2536\u2537\u2538\u2539\u253a\u253b\u253c\u253d\u253e\u253f\u2540\u2541\u2542\u2543\u2544\u2545\u2546\u2547\u2548\u2549\u254a\u254b\u254c\u254d\u254e\u254f\u2550\u2551\u2552\u2553\u2554\u2555\u2556\u2557\u2558\u2559\u255a\u255b\u255c\u255d\u255e\u255f\u2560\u2561\u2562\u2563\u2564\u2565\u2566\u2567\u2568\u2569\u256a\u256b\u256c\u256d\u256e\u256f\u2570\u2571\u2572\u2573\u2574\u2575\u2576\u2577\u2578\u2579\u257a\u257b\u257c\u257d\u257e\u257f\u2580\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588\u2589\u258a\u258b\u258c\u258d\u258e\u258f\u2590\u2591\u2592\u2593\u2594\u2595\u2596\u2597\u2598\u2599\u259a\u259b\u259c\u259d\u259e\u259f\u25a0\u25a1\u25a2\u25a3\u25a4\u25a5\u25a6\u25a7\u25a8\u25a9\u25aa\u25ab\u25ac\u25ad\u25ae\u25af\u25b0\u25b1\u25b2\u25b3\u25b4\u25b5\u25b6\u25b7\u25b8\u25b9\u25ba\u25bb\u25bc\u25bd\u25be\u25bf\u25c0\u25c1\u25c2\u25c3\u25c4\u25c5\u25c6\u25c7\u25c8\u25c9\u25ca\u25cb\u25cc\u25cd\u25ce\u25cf\u25d0\u25d1\u25d2\u25d3\u25d4\u25d5\u25d6\u25d7\u25d8\u25d9\u25da\u25db\u25dc\u25dd\u25de\u25df\u25e0\u25e1\u25e2\u25e3\u25e4\u25e5\u25e6\u25e7\u25e8\u25e9\u25ea\u25eb\u25ec\u25ed\u25ee\u25ef\u25f0\u25f1\u25f2\u25f3\u25f4\u25f5\u25f6\u25f7\u25f8\u25f9\u25fa\u25fb\u25fc\u25fd\u25fe\u25ff\u2600\u2601\u2602\u2603\u2604\u2605\u2606\u2607\u2608\u2609\u260a\u260b\u260c\u260d\u260e\u260f\u2610\u2611\u2612\u2613\u2614\u2615\u2616\u2617\u2618\u2619\u261a\u261b\u261c\u261d\u261e\u261f\u2620\u2621\u2622\u2623\u2624\u2625\u2626\u2627\u2628\u2629\u262a\u262b\u262c\u262d\u262e\u262f\u2630\u2631\u2632\u2633\u2634\u2635\u2636\u2637\u2638\u2639\u263a\u263b\u263c\u263d\u263e\u263f\u2640\u2641\u2642\u2643\u2644\u2645\u2646\u2647\u2648\u2649\u264a\u264b\u264c\u264d\u264e\u264f\u2650\u2651\u2652\u2653\u2654\u2655\u2656\u2657\u2658\u2659\u265a\u265b\u265c\u265d\u265e\u265f\u2660\u2661\u2662\u2663\u2664\u2665\u2666\u2667\u2668\u2669\u266a\u266b\u266c\u266d\u266e\u266f\u2670\u2671\u2672\u2673\u2674\u2675\u2676\u2677\u2678\u2679\u267a\u267b\u267c\u267d\u267e\u267f\u2680\u2681\u2682\u2683\u2684\u2685\u2686\u2687\u2688\u2689\u268a\u268b\u268c\u268d\u268e\u268f\u2690\u2691\u2692\u2693\u2694\u2695\u2696\u2697\u2698\u2699\u269a\u269b\u269c\u269d\u269e\u269f\u26a0\u26a1\u26a2\u26a3\u26a4\u26a5\u26a6\u26a7\u26a8\u26a9\u26aa\u26ab\u26ac\u26ad\u26ae\u26af\u26b0\u26b1\u26b2\u26b3\u26b4\u26b5\u26b6\u26b7\u26b8\u26b9\u26ba\u26bb\u26bc\u26bd\u26be\u26bf\u26c0\u26c1\u26c2\u26c3\u26c4\u26c5\u26c6\u26c7\u26c8\u26c9\u26ca\u26cb\u26cc\u26cd\u26ce\u26cf\u26d0\u26d1\u26d2\u26d3\u26d4\u26d5\u26d6\u26d7\u26d8\u26d9\u26da\u26db\u26dc\u26dd\u26de\u26df\u26e0\u26e1\u26e2\u26e3\u26e4\u26e5\u26e6\u26e7\u26e8\u26e9\u26ea\u26eb\u26ec\u26ed\u26ee\u26ef\u26f0\u26f1\u26f2\u26f3\u26f4\u26f5\u26f6\u26f7\u26f8\u26f9\u26fa\u26fb\u26fc\u26fd\u26fe\u26ff\u2701\u2702\u2703\u2704\u2705\u2706\u2707\u2708\u2709\u270a\u270b\u270c\u270d\u270e\u270f\u2710\u2711\u2712\u2713\u2714\u2715\u2716\u2717\u2718\u2719\u271a\u271b\u271c\u271d\u271e\u271f\u2720\u2721\u2722\u2723\u2724\u2725\u2726\u2727\u2728\u2729\u272a\u272b\u272c\u272d\u272e\u272f\u2730\u2731\u2732\u2733\u2734\u2735\u2736\u2737\u2738\u2739\u273a\u273b\u273c\u273d\u273e\u273f\u2740\u2741\u2742\u2743\u2744\u2745\u2746\u2747\u2748\u2749\u274a\u274b\u274c\u274d\u274e\u274f\u2750\u2751\u2752\u2753\u2754\u2755\u2756\u2757\u2758\u2759\u275a\u275b\u275c\u275d\u275e\u275f\u2760\u2761\u2762\u2763\u2764\u2765\u2766\u2767\u2768\u2769\u276a\u276b\u276c\u276d\u276e\u276f\u2770\u2771\u2772\u2773\u2774\u2775\u2794\u2795\u2796\u2797\u2798\u2799\u279a\u279b\u279c\u279d\u279e\u279f\u27a0\u27a1\u27a2\u27a3\u27a4\u27a5\u27a6\u27a7\u27a8\u27a9\u27aa\u27ab\u27ac\u27ad\u27ae\u27af\u27b0\u27b1\u27b2\u27b3\u27b4\u27b5\u27b6\u27b7\u27b8\u27b9\u27ba\u27bb\u27bc\u27bd\u27be\u27bf\u27c0\u27c1\u27c2\u27c3\u27c4\u27c5\u27c6\u27c7\u27c8\u27c9\u27ca\u27cb\u27cc\u27cd\u27ce\u27cf\u27d0\u27d1\u27d2\u27d3\u27d4\u27d5\u27d6\u27d7\u27d8\u27d9\u27da\u27db\u27dc\u27dd\u27de\u27df\u27e0\u27e1\u27e2\u27e3\u27e4\u27e5\u27e6\u27e7\u27e8\u27e9\u27ea\u27eb\u27ec\u27ed\u27ee\u27ef\u27f0\u27f1\u27f2\u27f3\u27f4\u27f5\u27f6\u27f7\u27f8\u27f9\u27fa\u27fb\u27fc\u27fd\u27fe\u27ff\u2800\u2801\u2802\u2803\u2804\u2805\u2806\u2807\u2808\u2809\u280a\u280b\u280c\u280d\u280e\u280f\u2810\u2811\u2812\u2813\u2814\u2815\u2816\u2817\u2818\u2819\u281a\u281b\u281c\u281d\u281e\u281f\u2820\u2821\u2822\u2823\u2824\u2825\u2826\u2827\u2828\u2829\u282a\u282b\u282c\u282d\u282e\u282f\u2830\u2831\u2832\u2833\u2834\u2835\u2836\u2837\u2838\u2839\u283a\u283b\u283c\u283d\u283e\u283f\u2840\u2841\u2842\u2843\u2844\u2845\u2846\u2847\u2848\u2849\u284a\u284b\u284c\u284d\u284e\u284f\u2850\u2851\u2852\u2853\u2854\u2855\u2856\u2857\u2858\u2859\u285a\u285b\u285c\u285d\u285e\u285f\u2860\u2861\u2862\u2863\u2864\u2865\u2866\u2867\u2868\u2869\u286a\u286b\u286c\u286d\u286e\u286f\u2870\u2871\u2872\u2873\u2874\u2875\u2876\u2877\u2878\u2879\u287a\u287b\u287c\u287d\u287e\u287f\u2880\u2881\u2882\u2883\u2884\u2885\u2886\u2887\u2888\u2889\u288a\u288b\u288c\u288d\u288e\u288f\u2890\u2891\u2892\u2893\u2894\u2895\u2896\u2897\u2898\u2899\u289a\u289b\u289c\u289d\u289e\u289f\u28a0\u28a1\u28a2\u28a3\u28a4\u28a5\u28a6\u28a7\u28a8\u28a9\u28aa\u28ab\u28ac\u28ad\u28ae\u28af\u28b0\u28b1\u28b2\u28b3\u28b4\u28b5\u28b6\u28b7\u28b8\u28b9\u28ba\u28bb\u28bc\u28bd\u28be\u28bf\u28c0\u28c1\u28c2\u28c3\u28c4\u28c5\u28c6\u28c7\u28c8\u28c9\u28ca\u28cb\u28cc\u28cd\u28ce\u28cf\u28d0\u28d1\u28d2\u28d3\u28d4\u28d5\u28d6\u28d7\u28d8\u28d9\u28da\u28db\u28dc\u28dd\u28de\u28df\u28e0\u28e1\u28e2\u28e3\u28e4\u28e5\u28e6\u28e7\u28e8\u28e9\u28ea\u28eb\u28ec\u28ed\u28ee\u28ef\u28f0\u28f1\u28f2\u28f3\u28f4\u28f5\u28f6\u28f7\u28f8\u28f9\u28fa\u28fb\u28fc\u28fd\u28fe\u28ff\u2900\u2901\u2902\u2903\u2904\u2905\u2906\u2907\u2908\u2909\u290a\u290b\u290c\u290d\u290e\u290f\u2910\u2911\u2912\u2913\u2914\u2915\u2916\u2917\u2918\u2919\u291a\u291b\u291c\u291d\u291e\u291f\u2920\u2921\u2922\u2923\u2924\u2925\u2926\u2927\u2928\u2929\u292a\u292b\u292c\u292d\u292e\u292f\u2930\u2931\u2932\u2933\u2934\u2935\u2936\u2937\u2938\u2939\u293a\u293b\u293c\u293d\u293e\u293f\u2940\u2941\u2942\u2943\u2944\u2945\u2946\u2947\u2948\u2949\u294a\u294b\u294c\u294d\u294e\u294f\u2950\u2951\u2952\u2953\u2954\u2955\u2956\u2957\u2958\u2959\u295a\u295b\u295c\u295d\u295e\u295f\u2960\u2961\u2962\u2963\u2964\u2965\u2966\u2967\u2968\u2969\u296a\u296b\u296c\u296d\u296e\u296f\u2970\u2971\u2972\u2973\u2974\u2975\u2976\u2977\u2978\u2979\u297a\u297b\u297c\u297d\u297e\u297f\u2980\u2981\u2982\u2983\u2984\u2985\u2986\u2987\u2988\u2989\u298a\u298b\u298c\u298d\u298e\u298f\u2990\u2991\u2992\u2993\u2994\u2995\u2996\u2997\u2998\u2999\u299a\u299b\u299c\u299d\u299e\u299f\u29a0\u29a1\u29a2\u29a3\u29a4\u29a5\u29a6\u29a7\u29a8\u29a9\u29aa\u29ab\u29ac\u29ad\u29ae\u29af\u29b0\u29b1\u29b2\u29b3\u29b4\u29b5\u29b6\u29b7\u29b8\u29b9\u29ba\u29bb\u29bc\u29bd\u29be\u29bf\u29c0\u29c1\u29c2\u29c3\u29c4\u29c5\u29c6\u29c7\u29c8\u29c9\u29ca\u29cb\u29cc\u29cd\u29ce\u29cf\u29d0\u29d1\u29d2\u29d3\u29d4\u29d5\u29d6\u29d7\u29d8\u29d9\u29da\u29db\u29dc\u29dd\u29de\u29df\u29e0\u29e1\u29e2\u29e3\u29e4\u29e5\u29e6\u29e7\u29e8\u29e9\u29ea\u29eb\u29ec\u29ed\u29ee\u29ef\u29f0\u29f1\u29f2\u29f3\u29f4\u29f5\u29f6\u29f7\u29f8\u29f9\u29fa\u29fb\u29fc\u29fd\u29fe\u29ff\u2a00\u2a01\u2a02\u2a03\u2a04\u2a05\u2a06\u2a07\u2a08\u2a09\u2a0a\u2a0b\u2a0c\u2a0d\u2a0e\u2a0f\u2a10\u2a11\u2a12\u2a13\u2a14\u2a15\u2a16\u2a17\u2a18\u2a19\u2a1a\u2a1b\u2a1c\u2a1d\u2a1e\u2a1f\u2a20\u2a21\u2a22\u2a23\u2a24\u2a25\u2a26\u2a27\u2a28\u2a29\u2a2a\u2a2b\u2a2c\u2a2d\u2a2e\u2a2f\u2a30\u2a31\u2a32\u2a33\u2a34\u2a35\u2a36\u2a37\u2a38\u2a39\u2a3a\u2a3b\u2a3c\u2a3d\u2a3e\u2a3f\u2a40\u2a41\u2a42\u2a43\u2a44\u2a45\u2a46\u2a47\u2a48\u2a49\u2a4a\u2a4b\u2a4c\u2a4d\u2a4e\u2a4f\u2a50\u2a51\u2a52\u2a53\u2a54\u2a55\u2a56\u2a57\u2a58\u2a59\u2a5a\u2a5b\u2a5c\u2a5d\u2a5e\u2a5f\u2a60\u2a61\u2a62\u2a63\u2a64\u2a65\u2a66\u2a67\u2a68\u2a69\u2a6a\u2a6b\u2a6c\u2a6d\u2a6e\u2a6f\u2a70\u2a71\u2a72\u2a73\u2a74\u2a75\u2a76\u2a77\u2a78\u2a79\u2a7a\u2a7b\u2a7c\u2a7d\u2a7e\u2a7f\u2a80\u2a81\u2a82\u2a83\u2a84\u2a85\u2a86\u2a87\u2a88\u2a89\u2a8a\u2a8b\u2a8c\u2a8d\u2a8e\u2a8f\u2a90\u2a91\u2a92\u2a93\u2a94\u2a95\u2a96\u2a97\u2a98\u2a99\u2a9a\u2a9b\u2a9c\u2a9d\u2a9e\u2a9f\u2aa0\u2aa1\u2aa2\u2aa3\u2aa4\u2aa5\u2aa6\u2aa7\u2aa8\u2aa9\u2aaa\u2aab\u2aac\u2aad\u2aae\u2aaf\u2ab0\u2ab1\u2ab2\u2ab3\u2ab4\u2ab5\u2ab6\u2ab7\u2ab8\u2ab9\u2aba\u2abb\u2abc\u2abd\u2abe\u2abf\u2ac0\u2ac1\u2ac2\u2ac3\u2ac4\u2ac5\u2ac6\u2ac7\u2ac8\u2ac9\u2aca\u2acb\u2acc\u2acd\u2ace\u2acf\u2ad0\u2ad1\u2ad2\u2ad3\u2ad4\u2ad5\u2ad6\u2ad7\u2ad8\u2ad9\u2ada\u2adb\u2adc\u2add\u2ade\u2adf\u2ae0\u2ae1\u2ae2\u2ae3\u2ae4\u2ae5\u2ae6\u2ae7\u2ae8\u2ae9\u2aea\u2aeb\u2aec\u2aed\u2aee\u2aef\u2af0\u2af1\u2af2\u2af3\u2af4\u2af5\u2af6\u2af7\u2af8\u2af9\u2afa\u2afb\u2afc\u2afd\u2afe\u2aff\u2b00\u2b01\u2b02\u2b03\u2b04\u2b05\u2b06\u2b07\u2b08\u2b09\u2b0a\u2b0b\u2b0c\u2b0d\u2b0e\u2b0f\u2b10\u2b11\u2b12\u2b13\u2b14\u2b15\u2b16\u2b17\u2b18\u2b19\u2b1a\u2b1b\u2b1c\u2b1d\u2b1e\u2b1f\u2b20\u2b21\u2b22\u2b23\u2b24\u2b25\u2b26\u2b27\u2b28\u2b29\u2b2a\u2b2b\u2b2c\u2b2d\u2b2e\u2b2f\u2b30\u2b31\u2b32\u2b33\u2b34\u2b35\u2b36\u2b37\u2b38\u2b39\u2b3a\u2b3b\u2b3c\u2b3d\u2b3e\u2b3f\u2b40\u2b41\u2b42\u2b43\u2b44\u2b45\u2b46\u2b47\u2b48\u2b49\u2b4a\u2b4b\u2b4c\u2b50\u2b51\u2b52\u2b53\u2b54\u2b55\u2b56\u2b57\u2b58\u2b59\u2ce5\u2ce6\u2ce7\u2ce8\u2ce9\u2cea\u2cf9\u2cfa\u2cfb\u2cfc\u2cfe\u2cff\u2d70\u2e00\u2e01\u2e02\u2e03\u2e04\u2e05\u2e06\u2e07\u2e08\u2e09\u2e0a\u2e0b\u2e0c\u2e0d\u2e0e\u2e0f\u2e10\u2e11\u2e12\u2e13\u2e14\u2e15\u2e16\u2e17\u2e18\u2e19\u2e1a\u2e1b\u2e1c\u2e1d\u2e1e\u2e1f\u2e20\u2e21\u2e22\u2e23\u2e24\u2e25\u2e26\u2e27\u2e28\u2e29\u2e2a\u2e2b\u2e2c\u2e2d\u2e2e\u2e30\u2e31\u2e32\u2e33\u2e34\u2e35\u2e36\u2e37\u2e38\u2e39\u2e3a\u2e3b\u2e80\u2e81\u2e82\u2e83\u2e84\u2e85\u2e86\u2e87\u2e88\u2e89\u2e8a\u2e8b\u2e8c\u2e8d\u2e8e\u2e8f\u2e90\u2e91\u2e92\u2e93\u2e94\u2e95\u2e96\u2e97\u2e98\u2e99\u2e9b\u2e9c\u2e9d\u2e9e\u2e9f\u2ea0\u2ea1\u2ea2\u2ea3\u2ea4\u2ea5\u2ea6\u2ea7\u2ea8\u2ea9\u2eaa\u2eab\u2eac\u2ead\u2eae\u2eaf\u2eb0\u2eb1\u2eb2\u2eb3\u2eb4\u2eb5\u2eb6\u2eb7\u2eb8\u2eb9\u2eba\u2ebb\u2ebc\u2ebd\u2ebe\u2ebf\u2ec0\u2ec1\u2ec2\u2ec3\u2ec4\u2ec5\u2ec6\u2ec7\u2ec8\u2ec9\u2eca\u2ecb\u2ecc\u2ecd\u2ece\u2ecf\u2ed0\u2ed1\u2ed2\u2ed3\u2ed4\u2ed5\u2ed6\u2ed7\u2ed8\u2ed9\u2eda\u2edb\u2edc\u2edd\u2ede\u2edf\u2ee0\u2ee1\u2ee2\u2ee3\u2ee4\u2ee5\u2ee6\u2ee7\u2ee8\u2ee9\u2eea\u2eeb\u2eec\u2eed\u2eee\u2eef\u2ef0\u2ef1\u2ef2\u2ef3\u2f00\u2f01\u2f02\u2f03\u2f04\u2f05\u2f06\u2f07\u2f08\u2f09\u2f0a\u2f0b\u2f0c\u2f0d\u2f0e\u2f0f\u2f10\u2f11\u2f12\u2f13\u2f14\u2f15\u2f16\u2f17\u2f18\u2f19\u2f1a\u2f1b\u2f1c\u2f1d\u2f1e\u2f1f\u2f20\u2f21\u2f22\u2f23\u2f24\u2f25\u2f26\u2f27\u2f28\u2f29\u2f2a\u2f2b\u2f2c\u2f2d\u2f2e\u2f2f\u2f30\u2f31\u2f32\u2f33\u2f34\u2f35\u2f36\u2f37\u2f38\u2f39\u2f3a\u2f3b\u2f3c\u2f3d\u2f3e\u2f3f\u2f40\u2f41\u2f42\u2f43\u2f44\u2f45\u2f46\u2f47\u2f48\u2f49\u2f4a\u2f4b\u2f4c\u2f4d\u2f4e\u2f4f\u2f50\u2f51\u2f52\u2f53\u2f54\u2f55\u2f56\u2f57\u2f58\u2f59\u2f5a\u2f5b\u2f5c\u2f5d\u2f5e\u2f5f\u2f60\u2f61\u2f62\u2f63\u2f64\u2f65\u2f66\u2f67\u2f68\u2f69\u2f6a\u2f6b\u2f6c\u2f6d\u2f6e\u2f6f\u2f70\u2f71\u2f72\u2f73\u2f74\u2f75\u2f76\u2f77\u2f78\u2f79\u2f7a\u2f7b\u2f7c\u2f7d\u2f7e\u2f7f\u2f80\u2f81\u2f82\u2f83\u2f84\u2f85\u2f86\u2f87\u2f88\u2f89\u2f8a\u2f8b\u2f8c\u2f8d\u2f8e\u2f8f\u2f90\u2f91\u2f92\u2f93\u2f94\u2f95\u2f96\u2f97\u2f98\u2f99\u2f9a\u2f9b\u2f9c\u2f9d\u2f9e\u2f9f\u2fa0\u2fa1\u2fa2\u2fa3\u2fa4\u2fa5\u2fa6\u2fa7\u2fa8\u2fa9\u2faa\u2fab\u2fac\u2fad\u2fae\u2faf\u2fb0\u2fb1\u2fb2\u2fb3\u2fb4\u2fb5\u2fb6\u2fb7\u2fb8\u2fb9\u2fba\u2fbb\u2fbc\u2fbd\u2fbe\u2fbf\u2fc0\u2fc1\u2fc2\u2fc3\u2fc4\u2fc5\u2fc6\u2fc7\u2fc8\u2fc9\u2fca\u2fcb\u2fcc\u2fcd\u2fce\u2fcf\u2fd0\u2fd1\u2fd2\u2fd3\u2fd4\u2fd5\u2ff0\u2ff1\u2ff2\u2ff3\u2ff4\u2ff5\u2ff6\u2ff7\u2ff8\u2ff9\u2ffa\u2ffb\u3000\u3001\u3002\u3003\u3004\u3008\u3009\u300a\u300b\u300c\u300d\u300e\u300f\u3010\u3011\u3012\u3013\u3014\u3015\u3016\u3017\u3018\u3019\u301a\u301b\u301c\u301d\u301e\u301f\u3020\u3030\u3036\u3037\u303d\u303e\u303f\u309b\u309c\u30a0\u30fb\u3190\u3191\u3196\u3197\u3198\u3199\u319a\u319b\u319c\u319d\u319e\u319f\u31c0\u31c1\u31c2\u31c3\u31c4\u31c5\u31c6\u31c7\u31c8\u31c9\u31ca\u31cb\u31cc\u31cd\u31ce\u31cf\u31d0\u31d1\u31d2\u31d3\u31d4\u31d5\u31d6\u31d7\u31d8\u31d9\u31da\u31db\u31dc\u31dd\u31de\u31df\u31e0\u31e1\u31e2\u31e3\u3200\u3201\u3202\u3203\u3204\u3205\u3206\u3207\u3208\u3209\u320a\u320b\u320c\u320d\u320e\u320f\u3210\u3211\u3212\u3213\u3214\u3215\u3216\u3217\u3218\u3219\u321a\u321b\u321c\u321d\u321e\u322a\u322b\u322c\u322d\u322e\u322f\u3230\u3231\u3232\u3233\u3234\u3235\u3236\u3237\u3238\u3239\u323a\u323b\u323c\u323d\u323e\u323f\u3240\u3241\u3242\u3243\u3244\u3245\u3246\u3247\u3250\u3260\u3261\u3262\u3263\u3264\u3265\u3266\u3267\u3268\u3269\u326a\u326b\u326c\u326d\u326e\u326f\u3270\u3271\u3272\u3273\u3274\u3275\u3276\u3277\u3278\u3279\u327a\u327b\u327c\u327d\u327e\u327f\u328a\u328b\u328c\u328d\u328e\u328f\u3290\u3291\u3292\u3293\u3294\u3295\u3296\u3297\u3298\u3299\u329a\u329b\u329c\u329d\u329e\u329f\u32a0\u32a1\u32a2\u32a3\u32a4\u32a5\u32a6\u32a7\u32a8\u32a9\u32aa\u32ab\u32ac\u32ad\u32ae\u32af\u32b0\u32c0\u32c1\u32c2\u32c3\u32c4\u32c5\u32c6\u32c7\u32c8\u32c9\u32ca\u32cb\u32cc\u32cd\u32ce\u32cf\u32d0\u32d1\u32d2\u32d3\u32d4\u32d5\u32d6\u32d7\u32d8\u32d9\u32da\u32db\u32dc\u32dd\u32de\u32df\u32e0\u32e1\u32e2\u32e3\u32e4\u32e5\u32e6\u32e7\u32e8\u32e9\u32ea\u32eb\u32ec\u32ed\u32ee\u32ef\u32f0\u32f1\u32f2\u32f3\u32f4\u32f5\u32f6\u32f7\u32f8\u32f9\u32fa\u32fb\u32fc\u32fd\u32fe\u3300\u3301\u3302\u3303\u3304\u3305\u3306\u3307\u3308\u3309\u330a\u330b\u330c\u330d\u330e\u330f\u3310\u3311\u3312\u3313\u3314\u3315\u3316\u3317\u3318\u3319\u331a\u331b\u331c\u331d\u331e\u331f\u3320\u3321\u3322\u3323\u3324\u3325\u3326\u3327\u3328\u3329\u332a\u332b\u332c\u332d\u332e\u332f\u3330\u3331\u3332\u3333\u3334\u3335\u3336\u3337\u3338\u3339\u333a\u333b\u333c\u333d\u333e\u333f\u3340\u3341\u3342\u3343\u3344\u3345\u3346\u3347\u3348\u3349\u334a\u334b\u334c\u334d\u334e\u334f\u3350\u3351\u3352\u3353\u3354\u3355\u3356\u3357\u3358\u3359\u335a\u335b\u335c\u335d\u335e\u335f\u3360\u3361\u3362\u3363\u3364\u3365\u3366\u3367\u3368\u3369\u336a\u336b\u336c\u336d\u336e\u336f\u3370\u3371\u3372\u3373\u3374\u3375\u3376\u3377\u3378\u3379\u337a\u337b\u337c\u337d\u337e\u337f\u3380\u3381\u3382\u3383\u3384\u3385\u3386\u3387\u3388\u3389\u338a\u338b\u338c\u338d\u338e\u338f\u3390\u3391\u3392\u3393\u3394\u3395\u3396\u3397\u3398\u3399\u339a\u339b\u339c\u339d\u339e\u339f\u33a0\u33a1\u33a2\u33a3\u33a4\u33a5\u33a6\u33a7\u33a8\u33a9\u33aa\u33ab\u33ac\u33ad\u33ae\u33af\u33b0\u33b1\u33b2\u33b3\u33b4\u33b5\u33b6\u33b7\u33b8\u33b9\u33ba\u33bb\u33bc\u33bd\u33be\u33bf\u33c0\u33c1\u33c2\u33c3\u33c4\u33c5\u33c6\u33c7\u33c8\u33c9\u33ca\u33cb\u33cc\u33cd\u33ce\u33cf\u33d0\u33d1\u33d2\u33d3\u33d4\u33d5\u33d6\u33d7\u33d8\u33d9\u33da\u33db\u33dc\u33dd\u33de\u33df\u33e0\u33e1\u33e2\u33e3\u33e4\u33e5\u33e6\u33e7\u33e8\u33e9\u33ea\u33eb\u33ec\u33ed\u33ee\u33ef\u33f0\u33f1\u33f2\u33f3\u33f4\u33f5\u33f6\u33f7\u33f8\u33f9\u33fa\u33fb\u33fc\u33fd\u33fe\u33ff\u4dc0\u4dc1\u4dc2\u4dc3\u4dc4\u4dc5\u4dc6\u4dc7\u4dc8\u4dc9\u4dca\u4dcb\u4dcc\u4dcd\u4dce\u4dcf\u4dd0\u4dd1\u4dd2\u4dd3\u4dd4\u4dd5\u4dd6\u4dd7\u4dd8\u4dd9\u4dda\u4ddb\u4ddc\u4ddd\u4dde\u4ddf\u4de0\u4de1\u4de2\u4de3\u4de4\u4de5\u4de6\u4de7\u4de8\u4de9\u4dea\u4deb\u4dec\u4ded\u4dee\u4def\u4df0\u4df1\u4df2\u4df3\u4df4\u4df5\u4df6\u4df7\u4df8\u4df9\u4dfa\u4dfb\u4dfc\u4dfd\u4dfe\u4dff\ua490\ua491\ua492\ua493\ua494\ua495\ua496\ua497\ua498\ua499\ua49a\ua49b\ua49c\ua49d\ua49e\ua49f\ua4a0\ua4a1\ua4a2\ua4a3\ua4a4\ua4a5\ua4a6\ua4a7\ua4a8\ua4a9\ua4aa\ua4ab\ua4ac\ua4ad\ua4ae\ua4af\ua4b0\ua4b1\ua4b2\ua4b3\ua4b4\ua4b5\ua4b6\ua4b7\ua4b8\ua4b9\ua4ba\ua4bb\ua4bc\ua4bd\ua4be\ua4bf\ua4c0\ua4c1\ua4c2\ua4c3\ua4c4\ua4c5\ua4c6\ua4fe\ua4ff\ua60d\ua60e\ua60f\ua670\ua671\ua672\ua673\ua67e\ua6f2\ua6f3\ua6f4\ua6f5\ua6f6\ua6f7\ua700\ua701\ua702\ua703\ua704\ua705\ua706\ua707\ua708\ua709\ua70a\ua70b\ua70c\ua70d\ua70e\ua70f\ua710\ua711\ua712\ua713\ua714\ua715\ua716\ua720\ua721\ua789\ua78a\ua828\ua829\ua82a\ua82b\ua836\ua837\ua838\ua839\ua874\ua875\ua876\ua877\ua8ce\ua8cf\ua8f8\ua8f9\ua8fa\ua92e\ua92f\ua95f\ua9c1\ua9c2\ua9c3\ua9c4\ua9c5\ua9c6\ua9c7\ua9c8\ua9c9\ua9ca\ua9cb\ua9cc\ua9cd\ua9de\ua9df\uaa5c\uaa5d\uaa5e\uaa5f\uaa77\uaa78\uaa79\uaade\uaadf\uaaf0\uaaf1\uabeb\ufb29\ufbb2\ufbb3\ufbb4\ufbb5\ufbb6\ufbb7\ufbb8\ufbb9\ufbba\ufbbb\ufbbc\ufbbd\ufbbe\ufbbf\ufbc0\ufbc1\ufd3e\ufd3f\ufdfc\ufdfd\ufe10\ufe11\ufe12\ufe13\ufe14\ufe15\ufe16\ufe17\ufe18\ufe19\ufe30\ufe31\ufe32\ufe33\ufe34\ufe35\ufe36\ufe37\ufe38\ufe39\ufe3a\ufe3b\ufe3c\ufe3d\ufe3e\ufe3f\ufe40\ufe41\ufe42\ufe43\ufe44\ufe45\ufe46\ufe47\ufe48\ufe49\ufe4a\ufe4b\ufe4c\ufe4d\ufe4e\ufe4f\ufe50\ufe51\ufe52\ufe54\ufe55\ufe56\ufe57\ufe58\ufe59\ufe5a\ufe5b\ufe5c\ufe5d\ufe5e\ufe5f\ufe60\ufe61\ufe62\ufe63\ufe64\ufe65\ufe66\ufe68\ufe69\ufe6a\ufe6b\ufeff\uff01\uff02\uff03\uff04\uff05\uff06\uff07\uff08\uff09\uff0a\uff0b\uff0c\uff0d\uff0e\uff0f\uff1a\uff1b\uff1c\uff1d\uff1e\uff1f\uff20\uff3b\uff3c\uff3d\uff3e\uff3f\uff40\uff5b\uff5c\uff5d\uff5e\uff5f\uff60\uff61\uff62\uff63\uff64\uff65\uffe0\uffe1\uffe2\uffe3\uffe4\uffe5\uffe6\uffe8\uffe9\uffea\uffeb\uffec\uffed\uffee\ufff9\ufffa\ufffb\ufffc\ufffd\ufffe\uffff\u00b5\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f9\u00fa\u00fb\u00fc\u00fd\u00ff\u0100\u0101\u0102\u0103\u0104\u0105\u0106\u0107\u0108\u0109\u010a\u010b\u010c\u010d\u010e\u010f\u0110\u0112\u0113\u0114\u0115\u0116\u0117\u0118\u0119\u011a\u011b\u011c\u011d\u011e\u011f\u0120\u0121\u0122\u0123\u0124\u0125\u0126\u0128\u0129\u012a\u012b\u012c\u012d\u012e\u012f\u0130\u0132\u0134\u0135\u0136\u0137\u0139\u013a\u013b\u013c\u013d\u013e\u013f\u0141\u0143\u0144\u0145\u0146\u0147\u0148\u014a\u014c\u014d\u014e\u014f\u0150\u0151\u0152\u0154\u0155\u0156\u0157\u0158\u0159\u015a\u015b\u015c\u015d\u015e\u015f\u0160\u0161\u0162\u0163\u0164\u0165\u0166\u0168\u0169\u016a\u016b\u016c\u016d\u016e\u016f\u0170\u0171\u0172\u0173\u0174\u0175\u0176\u0177\u0178\u0179\u017a\u017b\u017c\u017d\u017e\u017f\u0181\u0182\u0184\u0186\u0187\u0189\u018a\u018b\u018e\u018f\u0190\u0191\u0193\u0194\u0196\u0197\u0198\u019c\u019d\u019f\u01a0\u01a1\u01a2\u01a4\u01a6\u01a7\u01a9\u01ac\u01ae\u01af\u01b0\u01b1\u01b2\u01b3\u01b5\u01b7\u01b8\u01bc\u01c4\u01c5\u01c7\u01c8\u01ca\u01cb\u01cd\u01ce\u01cf\u01d0\u01d1\u01d2\u01d3\u01d4\u01d5\u01d6\u01d7\u01d8\u01d9\u01da\u01db\u01dc\u01de\u01df\u01e0\u01e2\u01e4\u01e6\u01e7\u01e8\u01e9\u01ea\u01eb\u01ec\u01ed\u01ee\u01f0\u01f1\u01f2\u01f4\u01f5\u01f6\u01f7\u01f8\u01f9\u01fa\u01fb\u01fc\u01fe\u0200\u0201\u0202\u0203\u0204\u0205\u0206\u0207\u0208\u0209\u020a\u020b\u020c\u020d\u020e\u020f\u0210\u0211\u0212\u0213\u0214\u0215\u0216\u0217\u0218\u0219\u021a\u021b\u021c\u021e\u021f\u0220\u0222\u0224\u0226\u0227\u0228\u0229\u022a\u022b\u022c\u022d\u022e\u022f\u0230\u0231\u0232\u0233\u023a\u023b\u023d\u023e\u0241\u0243\u0244\u0245\u0246\u0248\u024a\u024c\u024e\u0345\u0370\u0372\u0376\u0386\u0388\u0389\u038a\u038c\u038e\u038f\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039a\u039b\u039c\u039d\u039e\u039f\u03a0\u03a1\u03a3\u03a4\u03a5\u03a6\u03a7\u03a8\u03a9\u03aa\u03ab\u03c2\u03cf\u03d0\u03d1\u03d5\u03d6\u03d8\u03da\u03dc\u03de\u03e0\u03e2\u03e4\u03e6\u03e8\u03ea\u03ec\u03ee\u03f0\u03f1\u03f4\u03f5\u03f7\u03f9\u03fa\u03fd\u03fe\u03ff\u0400\u0401\u0402\u0403\u0404\u0405\u0406\u0407\u0408\u0409\u040a\u040b\u040c\u040d\u040e\u040f\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0460\u0462\u0464\u0466\u0468\u046a\u046c\u046e\u0470\u0472\u0474\u0476\u0478\u047a\u047c\u047e\u0480\u048a\u048c\u048e\u0490\u0492\u0494\u0496\u0498\u049a\u049c\u049e\u04a0\u04a2\u04a4\u04a6\u04a8\u04aa\u04ac\u04ae\u04b0\u04b2\u04b4\u04b6\u04b8\u04ba\u04bc\u04be\u04c0\u04c1\u04c3\u04c5\u04c7\u04c9\u04cb\u04cd\u04d0\u04d2\u04d4\u04d6\u04d8\u04da\u04dc\u04de\u04e0\u04e2\u04e4\u04e6\u04e8\u04ea\u04ec\u04ee\u04f0\u04f2\u04f4\u04f6\u04f8\u04fa\u04fc\u04fe\u0500\u0502\u0504\u0506\u0508\u050a\u050c\u050e\u0510\u0512\u0514\u0516\u0518\u051a\u051c\u051e\u0520\u0522\u0524\u0526\u0531\u0532\u0533\u0534\u0535\u0536\u0537\u0538\u0539\u053a\u053b\u053c\u053d\u053e\u053f\u0540\u0541\u0542\u0543\u0544\u0545\u0546\u0547\u0548\u0549\u054a\u054b\u054c\u054d\u054e\u054f\u0550\u0551\u0552\u0553\u0554\u0555\u0556\u10a0\u10a1\u10a2\u10a3\u10a4\u10a5\u10a6\u10a7\u10a8\u10a9\u10aa\u10ab\u10ac\u10ad\u10ae\u10af\u10b0\u10b1\u10b2\u10b3\u10b4\u10b5\u10b6\u10b7\u10b8\u10b9\u10ba\u10bb\u10bc\u10bd\u10be\u10bf\u10c0\u10c1\u10c2\u10c3\u10c4\u10c5\u10c7\u10cd\u1e00\u1e01\u1e02\u1e03\u1e04\u1e05\u1e06\u1e07\u1e08\u1e09\u1e0a\u1e0b\u1e0c\u1e0d\u1e0e\u1e0f\u1e10\u1e11\u1e12\u1e13\u1e14\u1e15\u1e16\u1e17\u1e18\u1e19\u1e1a\u1e1b\u1e1c\u1e1d\u1e1e\u1e1f\u1e20\u1e21\u1e22\u1e23\u1e24\u1e25\u1e26\u1e27\u1e28\u1e29\u1e2a\u1e2b\u1e2c\u1e2d\u1e2e\u1e2f\u1e30\u1e31\u1e32\u1e33\u1e34\u1e35\u1e36\u1e37\u1e38\u1e39\u1e3a\u1e3b\u1e3c\u1e3d\u1e3e\u1e3f\u1e40\u1e41\u1e42\u1e43\u1e44\u1e45\u1e46\u1e47\u1e48\u1e49\u1e4a\u1e4b\u1e4c\u1e4d\u1e4e\u1e4f\u1e50\u1e51\u1e52\u1e53\u1e54\u1e55\u1e56\u1e57\u1e58\u1e59\u1e5a\u1e5b\u1e5c\u1e5d\u1e5e\u1e5f\u1e60\u1e61\u1e62\u1e63\u1e64\u1e65\u1e66\u1e67\u1e68\u1e69\u1e6a\u1e6b\u1e6c\u1e6d\u1e6e\u1e6f\u1e70\u1e71\u1e72\u1e73\u1e74\u1e75\u1e76\u1e77\u1e78\u1e79\u1e7a\u1e7b\u1e7c\u1e7d\u1e7e\u1e7f\u1e80\u1e81\u1e82\u1e83\u1e84\u1e85\u1e86\u1e87\u1e88\u1e89\u1e8a\u1e8b\u1e8c\u1e8d\u1e8e\u1e8f\u1e90\u1e91\u1e92\u1e93\u1e94\u1e95\u1e96\u1e97\u1e98\u1e99\u1e9b\u1e9e\u1ea0\u1ea1\u1ea2\u1ea3\u1ea4\u1ea5\u1ea6\u1ea7\u1ea8\u1ea9\u1eaa\u1eab\u1eac\u1ead\u1eae\u1eaf\u1eb0\u1eb1\u1eb2\u1eb3\u1eb4\u1eb5\u1eb6\u1eb7\u1eb8\u1eb9\u1eba\u1ebb\u1ebc\u1ebd\u1ebe\u1ebf\u1ec0\u1ec1\u1ec2\u1ec3\u1ec4\u1ec5\u1ec6\u1ec7\u1ec8\u1ec9\u1eca\u1ecb\u1ecc\u1ecd\u1ece\u1ecf\u1ed0\u1ed1\u1ed2\u1ed3\u1ed4\u1ed5\u1ed6\u1ed7\u1ed8\u1ed9\u1eda\u1edb\u1edc\u1edd\u1ede\u1edf\u1ee0\u1ee1\u1ee2\u1ee3\u1ee4\u1ee5\u1ee6\u1ee7\u1ee8\u1ee9\u1eea\u1eeb\u1eec\u1eed\u1eee\u1eef\u1ef0\u1ef1\u1ef2\u1ef3\u1ef4\u1ef5\u1ef6\u1ef7\u1ef8\u1ef9\u1efa\u1efc\u1efe\u1f08\u1f09\u1f0a\u1f0b\u1f0c\u1f0d\u1f0e\u1f0f\u1f18\u1f19\u1f1a\u1f1b\u1f1c\u1f1d\u1f28\u1f29\u1f2a\u1f2b\u1f2c\u1f2d\u1f2e\u1f2f\u1f38\u1f39\u1f3a\u1f3b\u1f3c\u1f3d\u1f3e\u1f3f\u1f48\u1f49\u1f4a\u1f4b\u1f4c\u1f4d\u1f59\u1f5b\u1f5d\u1f5f\u1f68\u1f69\u1f6a\u1f6b\u1f6c\u1f6d\u1f6e\u1f6f\u1f88\u1f89\u1f8a\u1f8b\u1f8c\u1f8d\u1f8e\u1f8f\u1f98\u1f99\u1f9a\u1f9b\u1f9c\u1f9d\u1f9e\u1f9f\u1fa8\u1fa9\u1faa\u1fab\u1fac\u1fad\u1fae\u1faf\u1fb8\u1fb9\u1fba\u1fbb\u1fbc\u1fbe\u1fc8\u1fc9\u1fca\u1fcb\u1fcc\u1fd8\u1fd9\u1fda\u1fdb\u1fe8\u1fe9\u1fea\u1feb\u1fec\u1ff8\u1ff9\u1ffa\u1ffb\u1ffc\u2126\u212a\u212b\u2132\u2160\u2161\u2162\u2163\u2164\u2165\u2166\u2167\u2168\u2169\u216a\u216b\u216c\u216d\u216e\u216f\u2183\u2c00\u2c01\u2c02\u2c03\u2c04\u2c05\u2c06\u2c07\u2c08\u2c09\u2c0a\u2c0b\u2c0c\u2c0d\u2c0e\u2c0f\u2c10\u2c11\u2c12\u2c13\u2c14\u2c15\u2c16\u2c17\u2c18\u2c19\u2c1a\u2c1b\u2c1c\u2c1d\u2c1e\u2c1f\u2c20\u2c21\u2c22\u2c23\u2c24\u2c25\u2c26\u2c27\u2c28\u2c29\u2c2a\u2c2b\u2c2c\u2c2d\u2c2e\u2c60\u2c62\u2c63\u2c64\u2c67\u2c69\u2c6b\u2c6d\u2c6e\u2c6f\u2c70\u2c72\u2c75\u2c7e\u2c7f\u2c80\u2c82\u2c84\u2c86\u2c88\u2c8a\u2c8c\u2c8e\u2c90\u2c92\u2c94\u2c96\u2c98\u2c9a\u2c9c\u2c9e\u2ca0\u2ca2\u2ca4\u2ca6\u2ca8\u2caa\u2cac\u2cae\u2cb0\u2cb2\u2cb4\u2cb6\u2cb8\u2cba\u2cbc\u2cbe\u2cc0\u2cc2\u2cc4\u2cc6\u2cc8\u2cca\u2ccc\u2cce\u2cd0\u2cd2\u2cd4\u2cd6\u2cd8\u2cda\u2cdc\u2cde\u2ce0\u2ce2\u2ceb\u2ced\u2cf2\ua640\ua642\ua644\ua646\ua648\ua64a\ua64c\ua64e\ua650\ua652\ua654\ua656\ua658\ua65a\ua65c\ua65e\ua660\ua662\ua664\ua666\ua668\ua66a\ua66c\ua680\ua682\ua684\ua686\ua688\ua68a\ua68c\ua68e\ua690\ua692\ua694\ua696\ua722\ua724\ua726\ua728\ua72a\ua72c\ua72e\ua732\ua734\ua736\ua738\ua73a\ua73c\ua73e\ua740\ua742\ua744\ua746\ua748\ua74a\ua74c\ua74e\ua750\ua752\ua754\ua756\ua758\ua75a\ua75c\ua75e\ua760\ua762\ua764\ua766\ua768\ua76a\ua76c\ua76e\ua779\ua77b\ua77d\ua77e\ua780\ua782\ua784\ua786\ua78b\ua78d\ua790\ua792\ua7a0\ua7a2\ua7a4\ua7a6\ua7a8\ua7aa\uff21\uff22\uff23\uff24\uff25\uff26\uff27\uff28\uff29\uff2a\uff2b\uff2c\uff2d\uff2e\uff2f\uff30\uff31\uff32\uff33\uff34\uff35\uff36\uff37\uff38\uff39\uff3a\u0300\u0301\u0302\u0303\u0304\u0306\u0307\u0308\u0309\u030a\u030b\u030c\u030f\u0311\u031b\u0323\u0324\u0325\u0326\u0327\u0328\u032d\u032e\u0330\u0331', E'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   \u03bcaaaaaa\u00e6ceeeeiiii\u00f0nooooo\u00f8uuuuy\u00feaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccdd\u0111eeeeeeeeeegggggggghh\u0127iiiiiiiii\u0133jjkkllllll\u0140\u0142nnnnnn\u014boooooo\u0153rrrrrrsssssssstttt\u0167uuuuuuuuuuuuwwyyyzzzzzzs\u0253\u0183\u0185\u0254\u0188\u0256\u0257\u018c\u01dd\u0259\u025b\u0192\u0260\u0263\u0269\u0268\u0199\u026f\u0272\u0275oo\u01a3\u01a5\u0280\u01a8\u0283\u01ad\u0288uu\u028a\u028b\u01b4\u01b6\u0292\u01b9\u01bd\u01c6\u01c6\u01c9\u01c9\u01cc\u01ccaaiioouuuuuuuuuuaa\u01e1\u01e3\u01e5ggkkoooo\u01efj\u01f3\u01f3gg\u0195\u01bfnnaa\u01fd\u01ffaaaaeeeeiiiioooorrrruuuusstt\u021dhh\u019e\u0223\u0225aaeeooooooooyy\u2c65\u023c\u019a\u2c66\u0242\u0180\u0289\u028c\u0247\u0249\u024b\u024d\u024f\u03b9\u0371\u0373\u0377\u03ac\u03ad\u03ae\u03af\u03cc\u03cd\u03ce\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03b9\u03ba\u03bb\u03bc\u03bd\u03be\u03bf\u03c0\u03c1\u03c3\u03c4\u03c5\u03c6\u03c7\u03c8\u03c9\u03ca\u03cb\u03c3\u03d7\u03b2\u03b8\u03c6\u03c0\u03d9\u03db\u03dd\u03df\u03e1\u03e3\u03e5\u03e7\u03e9\u03eb\u03ed\u03ef\u03ba\u03c1\u03b8\u03b5\u03f8\u03f2\u03fb\u037b\u037c\u037d\u0450\u0451\u0452\u0453\u0454\u0455\u0456\u0457\u0458\u0459\u045a\u045b\u045c\u045d\u045e\u045f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f\u0461\u0463\u0465\u0467\u0469\u046b\u046d\u046f\u0471\u0473\u0475\u0477\u0479\u047b\u047d\u047f\u0481\u048b\u048d\u048f\u0491\u0493\u0495\u0497\u0499\u049b\u049d\u049f\u04a1\u04a3\u04a5\u04a7\u04a9\u04ab\u04ad\u04af\u04b1\u04b3\u04b5\u04b7\u04b9\u04bb\u04bd\u04bf\u04cf\u04c2\u04c4\u04c6\u04c8\u04ca\u04cc\u04ce\u04d1\u04d3\u04d5\u04d7\u04d9\u04db\u04dd\u04df\u04e1\u04e3\u04e5\u04e7\u04e9\u04eb\u04ed\u04ef\u04f1\u04f3\u04f5\u04f7\u04f9\u04fb\u04fd\u04ff\u0501\u0503\u0505\u0507\u0509\u050b\u050d\u050f\u0511\u0513\u0515\u0517\u0519\u051b\u051d\u051f\u0521\u0523\u0525\u0527\u0561\u0562\u0563\u0564\u0565\u0566\u0567\u0568\u0569\u056a\u056b\u056c\u056d\u056e\u056f\u0570\u0571\u0572\u0573\u0574\u0575\u0576\u0577\u0578\u0579\u057a\u057b\u057c\u057d\u057e\u057f\u0580\u0581\u0582\u0583\u0584\u0585\u0586\u2d00\u2d01\u2d02\u2d03\u2d04\u2d05\u2d06\u2d07\u2d08\u2d09\u2d0a\u2d0b\u2d0c\u2d0d\u2d0e\u2d0f\u2d10\u2d11\u2d12\u2d13\u2d14\u2d15\u2d16\u2d17\u2d18\u2d19\u2d1a\u2d1b\u2d1c\u2d1d\u2d1e\u2d1f\u2d20\u2d21\u2d22\u2d23\u2d24\u2d25\u2d27\u2d2daabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwys\u00dfaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyy\u1efb\u1efd\u1eff\u1f00\u1f01\u1f02\u1f03\u1f04\u1f05\u1f06\u1f07\u1f10\u1f11\u1f12\u1f13\u1f14\u1f15\u1f20\u1f21\u1f22\u1f23\u1f24\u1f25\u1f26\u1f27\u1f30\u1f31\u1f32\u1f33\u1f34\u1f35\u1f36\u1f37\u1f40\u1f41\u1f42\u1f43\u1f44\u1f45\u1f51\u1f53\u1f55\u1f57\u1f60\u1f61\u1f62\u1f63\u1f64\u1f65\u1f66\u1f67\u1f80\u1f81\u1f82\u1f83\u1f84\u1f85\u1f86\u1f87\u1f90\u1f91\u1f92\u1f93\u1f94\u1f95\u1f96\u1f97\u1fa0\u1fa1\u1fa2\u1fa3\u1fa4\u1fa5\u1fa6\u1fa7\u1fb0\u1fb1\u1f70\u1f71\u1fb3\u03b9\u1f72\u1f73\u1f74\u1f75\u1fc3\u1fd0\u1fd1\u1f76\u1f77\u1fe0\u1fe1\u1f7a\u1f7b\u1fe5\u1f78\u1f79\u1f7c\u1f7d\u1ff3\u03c9ka\u214e\u2170\u2171\u2172\u2173\u2174\u2175\u2176\u2177\u2178\u2179\u217a\u217b\u217c\u217d\u217e\u217f\u2184\u2c30\u2c31\u2c32\u2c33\u2c34\u2c35\u2c36\u2c37\u2c38\u2c39\u2c3a\u2c3b\u2c3c\u2c3d\u2c3e\u2c3f\u2c40\u2c41\u2c42\u2c43\u2c44\u2c45\u2c46\u2c47\u2c48\u2c49\u2c4a\u2c4b\u2c4c\u2c4d\u2c4e\u2c4f\u2c50\u2c51\u2c52\u2c53\u2c54\u2c55\u2c56\u2c57\u2c58\u2c59\u2c5a\u2c5b\u2c5c\u2c5d\u2c5e\u2c61\u026b\u1d7d\u027d\u2c68\u2c6a\u2c6c\u0251\u0271\u0250\u0252\u2c73\u2c76\u023f\u0240\u2c81\u2c83\u2c85\u2c87\u2c89\u2c8b\u2c8d\u2c8f\u2c91\u2c93\u2c95\u2c97\u2c99\u2c9b\u2c9d\u2c9f\u2ca1\u2ca3\u2ca5\u2ca7\u2ca9\u2cab\u2cad\u2caf\u2cb1\u2cb3\u2cb5\u2cb7\u2cb9\u2cbb\u2cbd\u2cbf\u2cc1\u2cc3\u2cc5\u2cc7\u2cc9\u2ccb\u2ccd\u2ccf\u2cd1\u2cd3\u2cd5\u2cd7\u2cd9\u2cdb\u2cdd\u2cdf\u2ce1\u2ce3\u2cec\u2cee\u2cf3\ua641\ua643\ua645\ua647\ua649\ua64b\ua64d\ua64f\ua651\ua653\ua655\ua657\ua659\ua65b\ua65d\ua65f\ua661\ua663\ua665\ua667\ua669\ua66b\ua66d\ua681\ua683\ua685\ua687\ua689\ua68b\ua68d\ua68f\ua691\ua693\ua695\ua697\ua723\ua725\ua727\ua729\ua72b\ua72d\ua72f\ua733\ua735\ua737\ua739\ua73b\ua73d\ua73f\ua741\ua743\ua745\ua747\ua749\ua74b\ua74d\ua74f\ua751\ua753\ua755\ua757\ua759\ua75b\ua75d\ua75f\ua761\ua763\ua765\ua767\ua769\ua76b\ua76d\ua76f\ua77a\ua77c\u1d79\ua77f\ua781\ua783\ua785\ua787\ua78c\u0265\ua791\ua793\ua7a1\ua7a3\ua7a5\ua7a7\ua7a9\u0266\uff41\uff42\uff43\uff44\uff45\uff46\uff47\uff48\uff49\uff4a\uff4b\uff4c\uff4d\uff4e\uff4f\uff50\uff51\uff52\uff53\uff54\uff55\uff56\uff57\uff58\uff59\uff5a') $search_fold$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_insert" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(NEW.description, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'products', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_insert"
AFTER INSERT ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_update" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(NEW.description, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'products', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_update"
AFTER UPDATE OF "id", "name", "description" ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_products_delete" ON "products";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_products_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'products' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_products_delete"
AFTER DELETE ON "products"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_products_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_insert" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.sku), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_variants', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_insert"
AFTER INSERT ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_update" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.sku IS DISTINCT FROM NEW.sku), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'product_variants' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.sku), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_variants', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_update"
AFTER UPDATE OF "id", "sku" ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_variants_delete" ON "product_variants";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_variants_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'product_variants' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_variants_delete"
AFTER DELETE ON "product_variants"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_variants_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_insert" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.description), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'categories', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_insert"
AFTER INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_update" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.description), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'categories', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_update"
AFTER UPDATE OF "id", "name", "description" ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_categories_delete" ON "categories";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_categories_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'categories' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_categories_delete"
AFTER DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_categories_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_insert" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(NEW.content, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'pages', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_insert"
AFTER INSERT ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_update" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.title IS DISTINCT FROM NEW.title OR OLD.content IS DISTINCT FROM NEW.content), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(NEW.content, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'pages', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_update"
AFTER UPDATE OF "id", "title", "content" ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_pages_delete" ON "pages";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_pages_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'pages' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_pages_delete"
AFTER DELETE ON "pages"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_pages_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_insert" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_email), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'orders', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_insert"
AFTER INSERT ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_update" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.customer_name IS DISTINCT FROM NEW.customer_name OR OLD.customer_phone IS DISTINCT FROM NEW.customer_phone OR OLD.customer_email IS DISTINCT FROM NEW.customer_email), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_email), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'orders', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_update"
AFTER UPDATE OF "id", "customer_name", "customer_phone", "customer_email" ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_orders_delete" ON "orders";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_orders_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'orders' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_orders_delete"
AFTER DELETE ON "orders"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_orders_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_insert" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.email), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'customers', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_insert"
AFTER INSERT ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_update" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.name IS DISTINCT FROM NEW.name OR OLD.phone IS DISTINCT FROM NEW.phone OR OLD.email IS DISTINCT FROM NEW.email), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.email), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'customers', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_update"
AFTER UPDATE OF "id", "name", "phone", "email" ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_customers_delete" ON "customers";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_customers_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'customers' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_customers_delete"
AFTER DELETE ON "customers"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_customers_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_insert" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.checkout_id), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.checkout_data), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'abandoned_checkouts', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_insert"
AFTER INSERT ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_update" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.customer_phone IS DISTINCT FROM NEW.customer_phone OR OLD.checkout_id IS DISTINCT FROM NEW.checkout_id OR OLD.checkout_data IS DISTINCT FROM NEW.checkout_data), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.checkout_id), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.checkout_data), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'abandoned_checkouts', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_update"
AFTER UPDATE OF "id", "customer_phone", "checkout_id", "checkout_data" ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_abandoned_checkouts_delete" ON "abandoned_checkouts";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'abandoned_checkouts' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_abandoned_checkouts_delete"
AFTER DELETE ON "abandoned_checkouts"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_abandoned_checkouts_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_insert" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.label), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.target_value), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.target_id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'navigation_menu_items', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_insert"
AFTER INSERT ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_update" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.label IS DISTINCT FROM NEW.label OR OLD.target_value IS DISTINCT FROM NEW.target_value OR OLD.target_id IS DISTINCT FROM NEW.target_id), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.label), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.target_value), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.target_id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'navigation_menu_items', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_update"
AFTER UPDATE OF "id", "label", "target_value", "target_id" ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_navigation_menu_items_delete" ON "navigation_menu_items";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'navigation_menu_items' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_navigation_menu_items_delete"
AFTER DELETE ON "navigation_menu_items"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_navigation_menu_items_delete_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_insert" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_insert_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.body), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.author_display_name), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_reviews', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_insert"
AFTER INSERT ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_insert_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_update" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  IF NOT coalesce((OLD.id IS DISTINCT FROM NEW.id OR OLD.title IS DISTINCT FROM NEW.title OR OLD.body IS DISTINCT FROM NEW.body OR OLD.author_display_name IS DISTINCT FROM NEW.author_display_name), false) THEN
    RETURN NEW;
  END IF;
  DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id;
  WITH words AS (SELECT NEW.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.body), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT NEW.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM unnest(string_to_array(scalius_compat.search_fts_fold(NEW.author_display_name), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_reviews', NEW.id, -1, '', count(*) FROM words;
  RETURN NEW;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_update"
AFTER UPDATE OF "id", "title", "body", "author_display_name" ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_update_fn"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "search_fts_terms_product_reviews_delete" ON "product_reviews";
CREATE OR REPLACE FUNCTION scalius_compat."search_fts_terms_product_reviews_delete_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $trigger_function$
BEGIN
  DELETE FROM search_fts_terms WHERE source = 'product_reviews' AND doc_id = OLD.id;
  RETURN OLD;
END
$trigger_function$;
CREATE TRIGGER "search_fts_terms_product_reviews_delete"
AFTER DELETE ON "product_reviews"
FOR EACH ROW EXECUTE FUNCTION scalius_compat."search_fts_terms_product_reviews_delete_fn"();
--> statement-breakpoint
DROP INDEX IF EXISTS search_fts_terms_term_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS search_fts_terms_doc_idx;
--> statement-breakpoint
DELETE FROM search_fts_terms;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM products AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM products AS src, unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(src.description, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'products', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'products', src.id, -1, '', coalesce(tokens.n, 0) FROM products AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM product_variants AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.sku), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_variants', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_variants', src.id, -1, '', coalesce(tokens.n, 0) FROM product_variants AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM categories AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM categories AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.description), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'categories', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'categories', src.id, -1, '', coalesce(tokens.n, 0) FROM categories AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM pages AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM pages AS src, unnest(string_to_array(scalius_compat.search_fts_fold(replace(replace(replace(replace(replace(replace(replace(replace(replace(regexp_replace(src.content, '<[^<>]*>', ' ', 'g'), '&nbsp', ' '), '&#160', ' '), '&amp', ' '), '&lt', ' '), '&gt', ' '), '&quot', ' '), '&#34', ' '), '&#39', ' '), '&apos', ' ')), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'pages', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'pages', src.id, -1, '', coalesce(tokens.n, 0) FROM pages AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.customer_name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.customer_email), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 3 AS col, substr(value, 1, 100) AS term FROM orders AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'orders', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'orders', src.id, -1, '', coalesce(tokens.n, 0) FROM orders AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.name), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM customers AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.email), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'customers', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'customers', src.id, -1, '', coalesce(tokens.n, 0) FROM customers AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.customer_phone), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.checkout_id), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM abandoned_checkouts AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.checkout_data), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'abandoned_checkouts', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'abandoned_checkouts', src.id, -1, '', coalesce(tokens.n, 0) FROM abandoned_checkouts AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.label), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.target_value), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM navigation_menu_items AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.target_id), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'navigation_menu_items', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'navigation_menu_items', src.id, -1, '', coalesce(tokens.n, 0) FROM navigation_menu_items AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
WITH words AS (SELECT src.id AS doc_id, 0 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.title), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 1 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.body), ' ')) AS word(value) WHERE value <> '' UNION ALL SELECT src.id AS doc_id, 2 AS col, substr(value, 1, 100) AS term FROM product_reviews AS src, unnest(string_to_array(scalius_compat.search_fts_fold(src.author_display_name), ' ')) AS word(value) WHERE value <> '') INSERT INTO search_fts_terms (source, doc_id, col, term, tf) SELECT 'product_reviews', doc_id, col, term, count(*) FROM words GROUP BY doc_id, col, term UNION ALL SELECT 'product_reviews', src.id, -1, '', coalesce(tokens.n, 0) FROM product_reviews AS src LEFT JOIN (SELECT doc_id, count(*) AS n FROM words GROUP BY doc_id) AS tokens ON tokens.doc_id = src.id;
--> statement-breakpoint
CREATE INDEX search_fts_terms_term_idx ON search_fts_terms (source, term, col, doc_id, tf);
--> statement-breakpoint
CREATE INDEX search_fts_terms_doc_idx ON search_fts_terms (source, doc_id, term, col, tf);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (220, '0220_search_plain_text_and_unicode_fold', 'ae5057a085c42c01a6fe3af3db5cc91798043ca7d4f15904e4781b7e1a06fbff');
