-- CreateTable
CREATE TABLE "_schema_health" (
    "id" UUID NOT NULL,
    "note" TEXT NOT NULL DEFAULT 'akabbo schema ok',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "_schema_health_pkey" PRIMARY KEY ("id")
);
