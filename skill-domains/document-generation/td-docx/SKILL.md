---
name: teradata-geospatial
description: 'Use Teradata geospatial data types and SQL/MM spatial functions for point-in-polygon analysis, spatial joins, distance calculations, and geospatial indexing workflows.'
metadata:
  author: teradata
  version: "1.0"
---

# Teradata Geospatial — ST_Geometry Types and Functions

> **Skill:** teradata-geospatial  
> **Domain:** 12-advanced-data-and-analytics-features / 02-geospatial  
> **Applies to:** Teradata Vantage 17.10+, VantageCloud Lake  

---

## Purpose

Guide agents through storing, querying, and manipulating geospatial data in Teradata using the ST_Geometry type system and SQL/MM Spatial (ISO/IEC 13249-3) functions.

---

## When to Use

- Point-in-polygon containment (customers in regions, stores in territories)
- Distance calculations (nearest store, delivery radius)
- Spatial joins (events within geographic areas)
- Buffer zones, intersections, unions of geometries
- Geospatial indexing for performance
- MGRS/military grid coordinate conversion
- Tracking data analysis (GeoSequence)

---

## Prerequisites

```sql
GRANT UDTUSAGE ON SYSUDTLIB TO username;
GRANT EXECUTE FUNCTION ON SYSSPATIAL TO username;
GRANT SELECT ON SYSSPATIAL TO username;
GRANT EXECUTE PROCEDURE ON SYSSPATIAL TO username;
```

---

## Geometry Types

| Type | Dim | Description |
|------|-----|-------------|
| `ST_Point` | 0D | Single location (lat/lon or x/y) |
| `ST_LineString` | 1D | Sequence of connected points |
| `ST_Polygon` | 2D | Closed ring(s), supports holes |
| `ST_MultiPoint` | 0D | Collection of points |
| `ST_MultiLineString` | 1D | Collection of line strings |
| `ST_MultiPolygon` | 2D | Collection of non-overlapping polygons |
| `ST_GeomCollection` | — | Mixed geometry collection |
| `GeoSequence` | 1D | LineString with timestamps (tracking data) |
| `MBR` / `MBB` | — | Minimum bounding rectangle / box |

---

## Column Definition

```sql
-- Standard geometry column
shape ST_Geometry                         -- 16MB max, 10KB inline
shape ST_Geometry(8000)                   -- 8KB max, always inline (best perf)
shape ST_Geometry(250000) INLINE LENGTH 2000  -- 250KB max, LOB if > 2KB
```

> Set `maxlength = INLINE LENGTH` for best UDF performance (avoids LOB overhead).

---

## Data Input (WKT)

```sql
INSERT INTO db.places VALUES (1, 'POINT(10 20)');
INSERT INTO db.places VALUES (2, 'LINESTRING(1 1, 2 2, 3 3)');
INSERT INTO db.places VALUES (3, 'POLYGON((0 0, 0 20, 20 20, 20 0, 0 0))');
```

---

## Key Spatial Functions

### Relationships

| Function | Returns | Use Case |
|----------|---------|----------|
| `a.ST_Within(b)` | 1 if a inside b | Point-in-polygon |
| `a.ST_Contains(b)` | 1 if a contains b | Region containment |
| `a.ST_Intersects(b)` | 1 if geometries overlap | Overlap detection |
| `a.ST_Crosses(b)` | 1 if geometries cross | Route intersection |
| `a.ST_Touches(b)` | 1 if boundaries touch | Adjacency |
| `a.ST_Equals(b)` | 1 if geometries equal | Exact match |
| `a.ST_Disjoint(b)` | 1 if no intersection | Exclusion |

### Distance

| Function | Returns |
|----------|---------|
| `a.ST_Distance(b)` | Planar distance |
| `a.ST_SpheroidalDistance(b)` | Geodetic distance (WGS84) |
| `a.ST_SphericalDistance(b)` | Great-circle distance |

### Measurement

| Function | Returns |
|----------|---------|
| `geom.ST_Area()` | Polygon area |
| `geom.ST_Perimeter()` | Polygon perimeter |
| `geom.ST_Length()` | LineString length |
| `geom.ST_Centroid()` | Center point |
| `geom.ST_Envelope()` | Bounding rectangle |
| `geom.ST_NumPoints()` | Number of vertices |

### Construction / Transformation

| Function | Purpose |
|----------|---------|
| `a.ST_Buffer(distance)` | Buffer zone around geometry |
| `a.ST_Union(b)` | Merge two geometries |
| `a.ST_Intersection(b)` | Common area |
| `a.ST_Difference(b)` | Subtract b from a |
| `a.ST_ConvexHull()` | Convex hull |
| `a.ST_Simplify(tolerance)` | Reduce vertices |

---

## Spatial Join Pattern

```sql
-- Find all stores within each sales territory
SELECT t.territory_name, s.store_id, s.store_name
FROM db.territories t
JOIN db.stores s ON s.location.ST_Within(t.boundary) = 1;
```

### With Geospatial Index (Performance)

```sql
-- Create NUSI for spatial join acceleration
CREATE INDEX store_geo_idx ON db.stores (location)
  AS GEOSPATIAL;

-- Spatial join uses the index automatically
SELECT t.territory_name, s.store_id
FROM db.territories t
JOIN db.stores s ON s.location.ST_Within(t.boundary) = 1;
```

---

## Proximity Search

```sql
-- Find stores within 50 km of a point
SELECT store_id, store_name,
       location.ST_SpheroidalDistance(NEW ST_Geometry('POINT(-97.74 30.27)')) AS dist_meters
FROM db.stores
WHERE location.ST_SpheroidalDistance(NEW ST_Geometry('POINT(-97.74 30.27)')) < 50000
ORDER BY dist_meters;
```

---

## Table Operators

| Function | Purpose |
|----------|---------|
| `AggGeom(USING Operation('Union'))` | Aggregate union of geometries (dissolve boundaries) |
| `GeometryToRows(ON ...)` | Explode polygon/linestring to individual point rows |
| `PolygonSplit(ON ...)` | Split large polygons for tessellation performance |

---

## MGRS Conversion

```sql
SELECT TO_MGRS(latitude, longitude, precision) FROM ...;
SELECT lat, lon FROM FROM_MGRS(mgrs_string);
```

---

## Common Pitfalls

| Mistake | Fix |
|---------|-----|
| Missing SYSUDTLIB grants | Grant UDTUSAGE, EXECUTE FUNCTION, SELECT on SYSSPATIAL |
| No geospatial index on join column | Create `GEOSPATIAL` NUSI for spatial join performance |
| Using `ST_Distance` for geodetic data | Use `ST_SpheroidalDistance` for real-world lat/lon distances |
| WKT > 64000 bytes | Use CLOB/BLOB constructors instead of VARCHAR |
| LOB overhead on small geometries | Set `maxlength = INLINE LENGTH` to keep data in-row |

---

## References


> **Access:** `skill_resource_read(action="read", skill="teradata-geospatial", path="references/FILENAME")` — do NOT call `list`.

| File | Content |
|------|---------|
| [geospatial.md](references/geospatial.md) | Full syntax: geometry types, constructors, all ST_* methods, MBR/MBB, transform groups, tessellation, GeoSequence, MGRS (731 lines) |

*Source: Teradata tdsql-mcp syntax library (ksturgeon-td/tdsql-mcp)*
