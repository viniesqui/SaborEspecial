import { MongoClient, ServerApiVersion } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

if (!uri) {
  throw new Error("Missing MONGODB_URI");
}

if (!dbName) {
  throw new Error("Missing MONGODB_DB_NAME");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true
  }
});

let clientPromise;

export async function getDb() {
  if (!clientPromise) {
    clientPromise = client.connect();
  }

  const connectedClient = await clientPromise;
  return connectedClient.db(dbName);
}
