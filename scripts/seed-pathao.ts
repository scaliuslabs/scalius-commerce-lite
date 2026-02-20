import { execSync } from "child_process";
import fs from "fs";
import { createId } from "@paralleldrive/cuid2";

const PATHAO_API_BASE_URL = "https://api-hermes.pathao.com";

function formatSqlString(str: string | null): string {
    if (str === null || str === undefined) return "NULL";
    // Escape single quotes with two single quotes for SQL
    return `'${str.replace(/'/g, "''")}'`;
}

async function run() {
    console.log("🚀 Starting Pathao location seed script...");

    // 1. Get Credentials from D1
    console.log("📦 Fetching Pathao credentials from local D1 database...");
    let d1Output = "";
    try {
        const cmd = `npx wrangler d1 execute scalius-commerce --local --command="SELECT credentials FROM delivery_providers WHERE type = 'pathao' LIMIT 1" --json`;
        d1Output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
        console.error("❌ Failed to query local D1 database. Ensure 'scalius-commerce' is the correct database name and wrangler is configured.");
        process.exit(1);
    }

    let parsed: any;
    try {
        parsed = JSON.parse(d1Output);
    } catch (err) {
        console.error("❌ Failed to parse D1 credentials output.");
        process.exit(1);
    }

    const credentialsJson = parsed[0]?.results?.[0]?.credentials;
    if (!credentialsJson) {
        console.error("❌ Pathao credentials not found in D1. Ensure the Pathao delivery provider is set up and saved in the admin panel.");
        process.exit(1);
    }

    const creds = JSON.parse(credentialsJson);

    // 2. Auth with Pathao
    console.log("🔐 Authenticating with Pathao API...");
    const tokenRes = await fetch(`${PATHAO_API_BASE_URL}/aladdin/api/v1/issue-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            username: creds.username,
            password: creds.password,
            grant_type: "password",
        }),
    });

    if (!tokenRes.ok) {
        const errorData = await tokenRes.json().catch(() => ({}));
        console.error("❌ Failed to authenticate with Pathao API", errorData);
        process.exit(1);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // 3. Fetch Cities
    console.log("🏙️ Fetching cities...");
    const citiesRes = await fetch(`${PATHAO_API_BASE_URL}/aladdin/api/v1/countries/1/city-list`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const citiesData = await citiesRes.json();
    const cities = citiesData.data.data;

    console.log(`✅ Found ${cities.length} cities.`);

    const cityRecords: any[] = [];
    const zoneRecords: any[] = [];

    const BATCH_SIZE = 5;

    // 4. Fetch Zones for all cities concurrently but batched
    console.log("🗺️ Fetching zones for cities...");
    for (let i = 0; i < cities.length; i += BATCH_SIZE) {
        const batch = cities.slice(i, i + BATCH_SIZE);

        // Process cities in this batch
        const batchPromises = batch.map(async (city: any) => {
            const cityId = createId();
            cityRecords.push({
                id: cityId,
                name: city.city_name,
                type: "city",
                parentId: null,
                externalIds: JSON.stringify({ pathao: city.city_id.toString() }),
                metadata: JSON.stringify({ original: city }),
            });

            // Fetch zones for the city
            try {
                const zonesRes = await fetch(`${PATHAO_API_BASE_URL}/aladdin/api/v1/cities/${city.city_id}/zone-list`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                if (zonesRes.ok) {
                    const zonesData = await zonesRes.json();
                    const zones = zonesData.data?.data || [];

                    for (const zone of zones) {
                        zoneRecords.push({
                            id: createId(),
                            name: zone.zone_name,
                            type: "zone",
                            parentId: cityId,
                            externalIds: JSON.stringify({ pathao: zone.zone_id.toString() }),
                            metadata: JSON.stringify({ original: zone }),
                        });
                    }
                }
            } catch (err) {
                console.error(`Warning: Failed to fetch zones for city ${city.city_name}`);
            }
        });

        await Promise.all(batchPromises);
        process.stdout.write(`...Processed ${Math.min(i + BATCH_SIZE, cities.length)}/${cities.length} cities\r`);
    }

    console.log(`\n✅ Fetched a total of ${zoneRecords.length} zones.`);

    // 5. Generate SQL Dump
    console.log("📝 Generating SQL dump file...");
    let sqlContent = `-- Auto-generated Pathao locations seed\n`;
    sqlContent += `DELETE FROM delivery_locations WHERE json_extract(external_ids, '$.pathao') IS NOT NULL;\n`;

    const allRecords = [...cityRecords, ...zoneRecords];

    allRecords.forEach(rec => {
        sqlContent += `INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active, sort_order) VALUES (${formatSqlString(rec.id)}, ${formatSqlString(rec.name)}, ${formatSqlString(rec.type)}, ${formatSqlString(rec.parentId)}, ${formatSqlString(rec.externalIds)}, ${formatSqlString(rec.metadata)}, 1, 0);\n`;
    });

    const sqlFilePath = "scripts/pathao_seed.sql";
    fs.writeFileSync(sqlFilePath, sqlContent);
    console.log(`✅ Saved generated SQL to ${sqlFilePath}`);

    // 6. Execute SQL
    console.log("⚙️ Executing SQL file against D1 database...");
    try {
        execSync(`npx wrangler d1 execute scalius-commerce --local --file=${sqlFilePath}`, { stdio: "inherit" });
        console.log("🎉 Seed completed successfully!");
    } catch (err) {
        console.error("❌ Failed to execute SQL script. Run it manually using: npx wrangler d1 execute scalius-commerce --local --file=scripts/pathao_seed.sql");
    }
}

run().catch(console.error);
