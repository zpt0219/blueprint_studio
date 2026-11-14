extends RefCounted

var groups := {}
var wall_colliders := []
var include_local_assets: bool
var box := BoxMesh.new()
var cylinder := CylinderMesh.new()

func _init(local_assets: bool) -> void:
    include_local_assets = local_assets
    cylinder.radial_segments = 12
    cylinder.rings = 0

func world_transform(node: Node3D) -> Transform3D:
    var transform := node.transform
    while not node.top_level and node.get_parent() is Node3D:
        node = node.get_parent()
        transform = node.transform * transform
    return transform

func visible(node: Node3D) -> bool:
    while node != null:
        if not node.visible: return false
        node = node.get_parent() as Node3D
    return true

func purchased(node: MeshInstance3D) -> bool:
    return "third_party" in node.mesh.resource_path or node.has_meta("unity_mesh")

func add(kind: String, faces: PackedVector3Array, transform: Transform3D) -> void:
    if faces.is_empty(): return
    if not groups.has(kind):
        groups[kind] = {"vertices": [], "triangles": [], "indices": {}}
    var group: Dictionary = groups[kind]
    var winding := [0, 1, 2] if transform.basis.determinant() < 0 else [0, 2, 1]
    for i in range(0, faces.size(), 3):
        for corner in winding:
            var point := (transform * faces[i + corner]).snapped(Vector3.ONE * 0.001)
            if not group.indices.has(point):
                group.indices[point] = group.vertices.size() / 3
                group.vertices.append_array([snappedf(point.x, 0.001), snappedf(point.y, 0.001), snappedf(point.z, 0.001)])
            group.triangles.append(group.indices[point])

func mesh(kind: String, node: MeshInstance3D) -> void:
    if node.mesh and visible(node):
        add(kind, node.mesh.get_faces(), world_transform(node))

func block(kind: String, transform: Transform3D, center: Vector3, size: Vector3) -> void:
    add(kind, box.get_faces(), transform.translated_local(center).scaled_local(size))

func wall_collision(transform: Transform3D, center: Vector3, size: Vector3) -> void:
    var at := transform * center
    var dimensions := size * transform.basis.get_scale().abs()
    wall_colliders.append({
        "position": [at.x, at.y, at.z], "size": [dimensions.x, dimensions.y, dimensions.z],
        "yaw": transform.basis.orthonormalized().get_euler().y,
    })

func lake_ruins(node: Node3D) -> void:
    for part: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
        if not part.mesh or not visible(part): continue
        var bounds := part.get_aabb()
        var transform := world_transform(part)
        var center := bounds.get_center()
        var size := bounds.size
        var arch := str(part.get_parent().name) == "Wall01"
        var native_model := include_local_assets or not purchased(part)
        if native_model: mesh("stone", part)
        if arch:
            for side in [-1.0, 1.0]:
                var pier := center + Vector3(side * size.x * 0.38, 0, 0)
                var pier_size := size * Vector3(0.24, 1, 1)
                if not native_model: block("stone", transform, pier, pier_size)
                wall_collision(transform, pier, pier_size)
            if not native_model:
                block("stone", transform, center + Vector3(0, size.y * 0.39, 0), size * Vector3(1, 0.22, 1))
        else:
            if not native_model: block("stone", transform, center, size)
            wall_collision(transform, center, size)

func round_part(kind: String, transform: Transform3D, center: Vector3, size: Vector3) -> void:
    add(kind, cylinder.get_faces(), transform.translated_local(center).scaled_local(size))

func roof(kind: String, transform: Transform3D, bounds: AABB, eave: float) -> void:
    var lo := bounds.position
    var hi := bounds.end
    var mid := bounds.get_center()
    var a := Vector3(lo.x, eave, lo.z)
    var b := Vector3(hi.x, eave, lo.z)
    var c := Vector3(hi.x, eave, hi.z)
    var d := Vector3(lo.x, eave, hi.z)
    var p := Vector3(mid.x, hi.y, lo.z)
    var q := Vector3(mid.x, hi.y, hi.z)
    add(kind, PackedVector3Array([a,b,p,c,d,q,a,p,q,a,q,d,b,c,q,b,q,p]), transform)

func building(node: Node3D, id: String) -> void:
    for part: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
        if not part.mesh or not visible(part): continue
        var bounds := part.get_aabb()
        var transform := world_transform(part)
        var world_size := (transform * bounds).size
        var part_name := str(part.get_parent().name).to_lower()
        var kind := "roof" if "roof" in part_name or id.contains("tent") else "building"
        if part_name.begins_with("door"): kind = "wood"
        if include_local_assets or not purchased(part):
            mesh(kind, part)
        elif world_size.x > 2.0 and world_size.z > 2.0 and world_size.y > 1.5:
            var size := bounds.size
            var center := bounds.get_center()
            if id.ends_with("castle") or id == "dragon_hall":
                var bottom := bounds.position.y
                block("building", transform, Vector3(center.x, bottom + size.y * 0.27, center.z), size * Vector3(0.88, 0.54, 0.81))
                for x in [-0.38, 0.38]:
                    for z in [-0.36, 0.36]:
                        var tower := Vector3(center.x + x * size.x, bottom + 0.45 * size.y, center.z + z * size.z)
                        round_part("building", transform, tower, size * Vector3(0.23, 0.9, 0.23))
                        round_part("roof", transform, Vector3(tower.x, bottom + 0.95 * size.y, tower.z), size * Vector3(0.26, 0.1, 0.26))
            elif id == "north_tower":
                round_part("building", transform, center, size * Vector3(0.9, 1, 0.9))
            else:
                var eave := bounds.position.y + size.y * (0.3 if kind == "roof" else 0.68)
                block(kind, transform, Vector3(center.x, (bounds.position.y + eave) / 2.0, center.z),
                    Vector3(size.x * 0.94, eave - bounds.position.y, size.z * 0.94))
                roof("roof", transform, bounds, eave)
        elif kind == "wood" and world_size.y > 0.75:
            block(kind, transform, bounds.get_center(), bounds.size)

func bridge(node: Node3D) -> void:
    var deck := node.get_node_or_null("WalkDeck") as MeshInstance3D
    if not deck or not deck.mesh: return
    mesh("bridge", deck)
    mesh("terrain", deck)
    for art: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
        if art == deck or not art.mesh or not visible(art): continue
        if include_local_assets or not purchased(art):
            mesh("wood", art)
            continue
        var bounds := world_transform(deck) * deck.get_aabb()
        var along_x := bounds.size.x > bounds.size.z
        var span := bounds.size.x if along_x else bounds.size.z
        var width := bounds.size.z if along_x else bounds.size.x
        var basis := Basis.IDENTITY if along_x else Basis(Vector3.UP, PI * 0.5)
        var center := bounds.get_center()
        center.y = bounds.end.y
        var placement := Transform3D(basis, center)
        block("wood", placement, Vector3(0, -0.2, 0), Vector3(span, 0.38, width))
        for side in [-1.0, 1.0]:
            var z: float = width * 0.47 * side
            block("wood", placement, Vector3(0, 0.72, z), Vector3(span, 0.14, 0.15))
            var count := maxi(2, ceili(span / 3))
            for i in range(count + 1):
                block("wood", placement, Vector3(lerpf(-span / 2, span / 2, float(i) / count), 0.36, z),
                    Vector3(0.16, 0.8, 0.17))

func fountain(node: Node3D) -> void:
    for part: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
        if not part.mesh or not visible(part): continue
        if include_local_assets or not purchased(part):
            mesh("stone", part)
        else:
            var bounds := part.get_aabb()
            var transform := world_transform(part)
            var ring := TorusMesh.new()
            ring.inner_radius = 0.39
            ring.outer_radius = 0.5
            ring.rings = 24
            ring.ring_segments = 8
            if "CarvedPier" in str(node.get_path_to(part)):
                round_part("stone", transform, bounds.get_center(), bounds.size)
            else:
                add("stone", ring.get_faces(), transform.translated_local(bounds.get_center())
                    .scaled_local(Vector3(bounds.size.x, bounds.size.y * 4, bounds.size.z)))

func wheel(node: Node3D) -> void:
    for part: MeshInstance3D in node.find_children("*", "MeshInstance3D", true, false):
        if not part.mesh or not visible(part): continue
        if include_local_assets or not purchased(part):
            mesh("wood", part)
            continue
        var bounds := world_transform(part) * part.get_aabb()
        var center := bounds.get_center()
        var size := bounds.size
        var ring := TorusMesh.new()
        ring.inner_radius = 0.42
        ring.outer_radius = 0.5
        ring.rings = 24
        ring.ring_segments = 8
        var upright := Basis(Vector3.RIGHT, PI / 2).scaled(Vector3(size.x, size.y, size.z * 4))
        add("wood", ring.get_faces(), Transform3D(upright, center))
        for i in 4:
            block("wood", Transform3D(Basis(Vector3.BACK, i * PI / 4), center), Vector3.ZERO,
                Vector3(minf(size.x, size.y) * 0.9, 0.06, size.z * 0.6))

func details() -> Array:
    var result := []
    for kind in groups:
        if kind == "terrain": continue
        result.append({"kind": kind, "vertices": groups[kind].vertices, "triangles": groups[kind].triangles})
    return result

func terrain_bytes() -> PackedByteArray:
    var terrain: Dictionary = groups.terrain
    var positions := PackedFloat32Array(terrain.vertices)
    var indices := PackedInt32Array(terrain.triangles)
    var header := PackedInt32Array([positions.size(), indices.size()])
    return header.to_byte_array() + positions.to_byte_array() + indices.to_byte_array()
