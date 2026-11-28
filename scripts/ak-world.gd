extends SceneTree
## Reads the native outdoor world into a Studio package, or checks a Studio patch against it.
const GAME := "res://scenes/world/ak_world.tscn"
const WEB_SCENE := preload("ak-web-scene.gd")
const STUDIO := preload("res://scripts/godot/AkStudioPatch.gd")
const METRES := STUDIO.METRES
const PREVIEW_RADIUS := 56.0
const PATCH_RAY_TOP := 256.0
const PATCH_RAY_BOTTOM := -64.0
const STEP_MOTION := preload("res://scripts/godot/StepMotion.gd")
const MATERIALS := [
    ["grass", "草地", "#749857"], ["sand", "沙地", "#d3ba88"], ["water", "水面", "#6a9ca9"],
    ["rock", "岩地", "#898882"], ["snow", "雪地", "#d8e4e4"], ["ice", "冰面", "#8fbbce"],
    ["lava", "岩浆", "#bd673a"], ["road", "道路", "#b79c72"],
]

var land: Node3D
var studio: RefCounted
var profile: Dictionary
var source: Dictionary
var origin: Vector2
var pristine_stage_dir := ""
var pristine_forward_map := {}

func _initialize() -> void:
    run.call_deferred()

func run() -> void:
    var args := OS.get_cmdline_user_args()
    if args.size() != 2 or args[0] not in ["--export", "--export-local", "--check-patch", "--preview-patch"]:
        fail("Usage: -- --export or --export-local /path/to/ak-world.bptilemap | --check-patch or --preview-patch /path/to/patch.json")
        return
    if args[0] in ["--check-patch", "--preview-patch"]:
        maybe_stage_pristine_for_patch(args[1])
    await load_world()
    if args[0] in ["--export", "--export-local"]:
        export_map(args[1], args[0] == "--export-local")
    else:
        check_patch(args[1], args[0] == "--preview-patch")

func _collect_gz_files(base_abs: String, cur_abs: String, out_rels: Array[String]) -> void:
    var dir := DirAccess.open(cur_abs)
    if dir == null:
        return
    dir.list_dir_begin()
    var entry := dir.get_next()
    while not entry.is_empty():
        if entry != "." and entry != "..":
            var full := cur_abs.path_join(entry)
            if dir.current_is_dir():
                _collect_gz_files(base_abs, full, out_rels)
            elif entry.ends_with(".tscn.gz"):
                out_rels.append(full.trim_prefix(base_abs.trim_suffix("/") + "/").trim_suffix(".gz"))
        entry = dir.get_next()
    dir.list_dir_end()

func _remove_dir_all(abs_dir: String) -> void:
    if abs_dir.is_empty() or not DirAccess.dir_exists_absolute(abs_dir):
        return
    var dir := DirAccess.open(abs_dir)
    if dir != null:
        dir.list_dir_begin()
        var entry := dir.get_next()
        while not entry.is_empty():
            if entry != "." and entry != "..":
                var full := abs_dir.path_join(entry)
                if dir.current_is_dir():
                    _remove_dir_all(full)
                else:
                    dir.remove(entry)
            entry = dir.get_next()
        dir.list_dir_end()
    DirAccess.remove_absolute(abs_dir)

func cleanup_pristine_stage() -> void:
    if not pristine_stage_dir.is_empty():
        _remove_dir_all(pristine_stage_dir)
        pristine_stage_dir = ""
        pristine_forward_map.clear()

func maybe_stage_pristine_for_patch(patch_path: String) -> void:
    if not FileAccess.file_exists(patch_path):
        return
    var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(patch_path))
    if not parsed is Dictionary:
        return
    var patch_rev := str(parsed.get("revision", ""))
    var live_rev := STUDIO.revision()
    var base_rev := STUDIO.baseline_revision()
    if patch_rev.is_empty() or patch_rev == live_rev or patch_rev != base_rev:
        return
    var base_files_abs := ProjectSettings.globalize_path("res://tools/studio/baseline/files")
    if not DirAccess.dir_exists_absolute(base_files_abs):
        return
    var rels: Array[String] = []
    _collect_gz_files(base_files_abs, base_files_abs, rels)
    if rels.is_empty():
        return
    pristine_stage_dir = "/tmp/ak_studio_check_%d_%d" % [OS.get_process_id(), Time.get_ticks_usec()]
    for rel in rels:
        pristine_forward_map["res://" + rel] = pristine_stage_dir.path_join(rel)
    for rel in rels:
        var raw_gz := FileAccess.get_file_as_bytes(base_files_abs.path_join(rel + ".gz"))
        var text := raw_gz.decompress_dynamic(-1, FileAccess.COMPRESSION_GZIP).get_string_from_utf8()
        for orig_res: String in pristine_forward_map:
            if orig_res != ("res://" + rel) and orig_res in text:
                text = text.replace('"' + orig_res + '"', '"' + str(pristine_forward_map[orig_res]) + '"')
        var out_abs: String = pristine_forward_map["res://" + rel]
        DirAccess.make_dir_recursive_absolute(out_abs.get_base_dir())
        var f := FileAccess.open(out_abs, FileAccess.WRITE)
        if f != null:
            f.store_string(text)
            f.close()

func load_world() -> void:
    var base_path: String = str(pristine_forward_map.get(STUDIO.BASE, STUDIO.BASE))
    land = ResourceLoader.load(base_path, "", ResourceLoader.CACHE_MODE_REPLACE).instantiate()
    root.add_child(land)
    studio = STUDIO.new(land)
    profile = studio.profile
    source = studio.grid
    origin = studio.origin
    ground_bodies()
    await physics_frame
    await physics_frame

func fail(message: String) -> void:
    cleanup_pristine_stage()
    printerr(message)
    quit(1)

func revision() -> String:
    return STUDIO.revision()

func ground_bodies() -> Array[CollisionObject3D]:
    return studio.ground_bodies()

func sample(x: float, z: float) -> Dictionary:
    return studio.sample(x, z)

func patched_sample(x: float, z: float) -> Dictionary:
    return studio.sample(x, z, PATCH_RAY_TOP, PATCH_RAY_BOTTOM)

func xyz(value: Vector3) -> Array:
    return [snappedf(value.x, 0.001), snappedf(value.y, 0.001), snappedf(value.z, 0.001)]

func marker(id: String, title: String, at: Array) -> Dictionary:
    var hit := sample(at[0], at[2])
    var floor_y: float = hit.position.y if not hit.is_empty() else at[1]
    return {"id": id, "name": title, "position": xyz(Vector3(at[0], floor_y, at[2]))}

func scene_details(local_assets: bool) -> Dictionary:
    var authored: Node3D = load(STUDIO.LANDSCAPE).instantiate()
    var game: Node3D = load(GAME).instantiate()
    var preview := WEB_SCENE.new(local_assets)
    var terrain := authored.get_node("Terrain")
    var ice := terrain.get_node("IceFields")
    preview.mesh("frost", ice.get_node("FrostRim"))
    preview.mesh("ice", ice)
    for region in terrain.get_children():
        var surface := region.get_node_or_null("Surface") as MeshInstance3D
        if surface: preview.mesh("terrain", surface)
    for path in ["SnowWestJunction", "DragonLavaBasin/Banks", "TidalPocket/SubmergedSand"]:
        preview.mesh("terrain", terrain.get_node(path))
    for part: MeshInstance3D in terrain.get_node("DragonLavaExpansion").find_children("Banks", "MeshInstance3D", true, false):
        preview.mesh("terrain", part)
    preview.mesh("sea", authored.get_node("SurroundingSea"))
    preview.mesh("tide", terrain.get_node("TidalPocket/StillWater"))
    preview.mesh("lava", terrain.get_node("LavaPools"))
    preview.mesh("lava", terrain.get_node("DragonLavaBasin/MoltenSurface"))
    for path in ["DragonLavaBasin/Bubbles", "DragonLavaExpansion/Bubbles"]:
        preview.mesh("embers", terrain.get_node(path))
    var walls := authored.get_node("Buildings/KingdomSettlements/CastleQuarter/Walls")
    for shape: CollisionShape3D in walls.find_children("*", "CollisionShape3D", true, false):
        if not shape.disabled and shape.shape is BoxShape3D:
            var transform := preview.world_transform(shape)
            preview.block("wall", transform, Vector3.ZERO, shape.shape.size)
            preview.wall_collision(transform, Vector3.ZERO, shape.shape.size)
    preview.lake_ruins(authored.get_node("Buildings/LakeRuins"))
    for id in profile.Buildings:
        var building := authored.get_node_or_null(profile.Buildings[id].SourceNode) as Node3D
        if building: preview.building(building, id)
    for bridge: Node3D in authored.get_node("Bridges").get_children():
        preview.bridge(bridge)
    for pier: MeshInstance3D in authored.get_node("Buildings/WorldDetail/BridgeMasonry").find_children("*", "MeshInstance3D", true, false):
        if not pier.mesh or not preview.visible(pier): continue
        if local_assets or not preview.purchased(pier):
            preview.mesh("stone", pier)
        else:
            var bounds := pier.get_aabb()
            preview.block("stone", preview.world_transform(pier), bounds.get_center(), bounds.size)
    preview.fountain(authored.get_node("Buildings/KingdomSettlements/CastleQuarter/RoyalFountain"))
    for path in ["Props/WestWheelVisual", "Props/EastWheelVisual"]:
        preview.wheel(game.get_node(path))

    var cards := []
    var textures := {}
    for card in authored.find_children("*", "Sprite3D", true, false):
        if card.texture == null: continue
        var transform: Transform3D = card.transform
        var visible: bool = card.visible
        var parent: Node = card.get_parent()
        while parent is Node3D:
            visible = visible and parent.visible
            if not parent.top_level: transform = parent.transform * transform
            parent = parent.get_parent()
        if not visible: continue
        var path: String = card.texture.resource_path
        var texture_id := path.sha256_text().substr(0, 20)
        textures[texture_id] = path
        var crop: Rect2 = card.region_rect if card.region_enabled else Rect2(Vector2.ZERO, card.texture.get_size())
        var frame_size := crop.size / Vector2(card.hframes, card.vframes)
        crop.position += Vector2(card.frame_coords) * frame_size
        crop.size = frame_size
        var scale := Vector2(transform.basis.x.length(), transform.basis.y.length())
        var size: Vector2 = frame_size * card.pixel_size * scale
        var offset: Vector2 = card.offset * card.pixel_size * scale
        if not card.centered: offset += size * 0.5
        var modulate: Color = card.modulate
        cards.append({
            "id": str(authored.get_path_to(card)), "name": str(card.get_meta("ecology_species", card.get_parent().name)),
            "texture": texture_id, "position": xyz(transform.origin),
            "size": [size.x, size.y], "offset": [offset.x, offset.y],
            "region": [crop.position.x, crop.position.y, crop.size.x, crop.size.y],
            "flipH": card.flip_h, "flipV": card.flip_v,
            "color": [modulate.r, modulate.g, modulate.b, modulate.a],
            "threshold": card.alpha_scissor_threshold,
        })
    authored.free()
    game.free()
    return {"cards": cards, "textures": textures, "geometry": preview.details(), "terrain": preview.terrain_bytes(),
        "wallColliders": preview.wall_colliders}

func export_map(output: String, local_assets: bool) -> void:
    var width := int(source.width)
    var height := int(source.height)
    if source.tile_metres != METRES or Vector2(width, height) * METRES != Vector2(profile.Bounds[2], profile.Bounds[3]) - origin:
        fail("The AK grid and runtime bounds no longer match.")
        return
    var heights := []
    var lava_cells := []
    var ground := {}
    var roads := {}
    var native_count := 0
    for z in range(height):
        for x in range(width):
            var i := z * width + x
            var centre := origin + (Vector2(x, z) + Vector2(0.5, 0.5)) * METRES
            var hit := sample(centre.x, centre.y)
            var path := "" if hit.is_empty() else str(land.get_path_to(hit.collider)).to_lower()
            var floor_y: float = -2.0 if hit.is_empty() else snappedf(hit.position.y, 0.001)
            heights.append(floor_y)
            if not hit.is_empty(): native_count += 1
            var palette := "water" if hit.is_empty() else STUDIO.biome(path)
            ground[str(i)] = {"palette": palette}
            if palette == "lava": lava_cells.append(i)
            if not hit.is_empty() and (source.roads[i] > 0 or path.begins_with("bridges/") or "castlestreets" in path
                or "coastpaths" in path or "paving" in path or "regionpaths" in path):
                roads[str(i)] = {"palette": "road"}

    var markers := [
        marker("royal-castle", "王城出口", profile.CastleExit),
        marker("royal-fountain", "喷泉广场", [-254.0, 3.08, 81.0]),
        marker("inn", "旅馆外", profile.InnExit),
        marker("studio-snow-stairs", "雪原阶梯旁", [-286.0, 21.0, -206.0]),
    ]
    for id in profile.Waypoints:
        var point: Dictionary = profile.Waypoints[id]
        markers.append(marker("waypoint-" + id, point.Name, [point.X, point.Y, point.Z]))

    var atlas := Image.create_empty(16 * MATERIALS.size(), 16, false, Image.FORMAT_RGBA8)
    var palettes := []
    for i in range(MATERIALS.size()):
        var entry: Array = MATERIALS[i]
        var x := i * 16
        atlas.fill_rect(Rect2i(x, 0, 16, 16), Color.html(entry[2]))
        palettes.append({"id": entry[0], "name": entry[1], "tileset": "ak-debug", "mode": "single", "tiles": [[x, 0]], "height": 0})

    var details := scene_details(local_assets)
    var world := {
        "id": profile.Id, "revision": revision(), "origin": [origin.x, origin.y], "metresPerTile": METRES,
        "heights": heights, "markers": markers, "proxies": [],
        "cards": details.cards, "textures": details.textures.keys().map(func(id): return {"id": id}),
        "details": details.geometry, "terrain": true, "lavaCells": lava_cells,
        "wallColliders": details.wallColliders, "previewVersion": 2,
    }
    var project := {
        "format": "blueprint-tilemap", "version": 1, "width": width, "height": height,
        "tilesets": [{"id": "ak-debug", "name": "AK 调试色板.png", "tileSize": 16}], "palettes": palettes,
        "layers": [
            {"id": "ak-ground", "name": "地面", "visible": true, "cells": ground},
            {"id": "ak-roads", "name": "道路", "visible": true, "cells": roads},
        ],
        "world": world,
    }
    var pack := ZIPPacker.new()
    var result := pack.open(output)
    if result != OK:
        fail("Cannot write package: " + error_string(result))
        return
    for texture_id in details.textures:
        pack.start_file("decorations/" + texture_id + ".png")
        pack.write_file(FileAccess.get_file_as_bytes(details.textures[texture_id]))
        pack.close_file()
    pack.start_file("world/terrain.bin")
    pack.write_file(details.terrain)
    pack.close_file()
    pack.start_file("project.json")
    pack.write_file(JSON.stringify(project).to_utf8_buffer())
    pack.close_file()
    pack.start_file("tilesets/ak-debug.png")
    pack.write_file(atlas.save_png_to_buffer())
    pack.close_file()
    pack.close()
    print("AK %dx%d, %d native ground samples, %d road cells, %d markers." % [
        width, height, native_count, roads.size(), markers.size(),
    ])
    print("%d outdoor cards, %d original PNG atlases." % [details.cards.size(), details.textures.size()])
    for detail in details.geometry:
        print("%s: %d triangles." % [detail.kind, detail.triangles.size() / 3])
    for item in markers.slice(0, 3): print(item.name, " ", item.position)
    quit()

func check_patch(path: String, preview: bool) -> void:
    var patch: Dictionary = studio.read(path)
    if patch.has("error"):
        fail(patch.error)
        return
    var target: Vector3 = patch.target
    var floor_hit := sample(target.x, target.z)
    var native_point: Variant = null if floor_hit.is_empty() else xyz(floor_hit.position)
    var chunks := mount_nearby(target, patch.cards.keys(), patch)
    await physics_frame
    await physics_frame
    var overrides_stats: Dictionary = studio.apply_overrides(patch)
    var card_changes: Dictionary = studio.prepare_cards(patch.cards)
    if card_changes.has("error"):
        fail(card_changes.error)
        return
    var native_blocked: Variant = null if floor_hit.is_empty() else capsule_blocked(floor_hit.position)
    var result: Dictionary = studio.apply_ground(patch, preview)
    if result.has("error"):
        fail(result.error)
        return
    studio.apply_cards(card_changes.edits)
    await physics_frame
    await physics_frame
    for edit in patch.heights.values():
        var at: Vector3 = edit.position
        var hit := patched_sample(at.x, at.z)
        var ok_collider: bool = not hit.is_empty() and (hit.collider == result.body or hit.collider.get_meta("studio_ground", false))
        if not ok_collider or absf(hit.position.y - at.y) > 0.05:
            fail("Patched floor was not reached at " + str(at) + " (got " + str(hit.get("position", null)) + ")")
            return
    for row in patch.cards.values():
        var node := land.get_node_or_null(NodePath(row.id)) as Sprite3D
        if row.position == null:
            if node == null: continue
        elif node != null and node.global_position.distance_to(STUDIO.point(row.position)) <= 0.15:
            continue
        fail("Decoration edit did not apply: " + str(row.id))
        return
    var landed := patched_sample(target.x, target.z)
    var landing: Variant = null if landed.is_empty() else xyz(landed.position)
    var patched_blocked: Variant = null if landed.is_empty() else capsule_blocked(landed.position)
    print(JSON.stringify({
        "pristineStaged": not pristine_stage_dir.is_empty(),
        "materialEdits": patch.changes.size(), "heightEdits": patch.heights.size(),
        "painted": result.paintedTiles.size(), "unsupportedPaint": result.unsupportedPaint.size(),
        "decorationEdits": patch.cards.size(), "overrides3D": patch.get("overrides3D", []).size(),
        "autoStairTreads": patch.get("autoStairTreads", {}).size(),
        "encounters": patch.get("encounters", []).size(),
        "testPoint": xyz(target),
        "nativeGround": native_point, "nativeGroundNormal": null if floor_hit.is_empty() else xyz(floor_hit.normal),
        "nativeCapsuleBlocked": native_blocked, "nearbyChunks": chunks,
        "patchedGround": landing, "patchedCapsuleBlocked": patched_blocked,
        "cutShapes": result.cutShapes, "cutMeshes": result.cutMeshes,
    }))
    if not preview:
        cleanup_pristine_stage()
        quit()
        return
    show_patch(target, landed)

func apply_elevations(edits: Array, visuals := false) -> Dictionary:
    var terrain := STUDIO.TERRAIN.new(origin, METRES, edits)
    return terrain.apply(land, ground_bodies(), sample, visuals)

func capsule_blocked(at: Vector3) -> bool:
    return studio.capsule_blocked(at)

func mount_nearby(target: Vector3, source_paths: Array = [], patch: Dictionary = {}) -> int:
    var manifest: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(STUDIO.MANIFEST))
    var paths := {}
    for path in source_paths: paths[path] = true
    var required: Dictionary = studio.required_chunks(manifest.chunks, paths, patch)
    var loaded := 0
    for row in manifest.chunks:
        var b: Array = row.bounds
        var dx := maxf(b[0] - target.x, maxf(0.0, target.x - b[0] - b[3]))
        var dz := maxf(b[2] - target.z, maxf(0.0, target.z - b[2] - b[5]))
        if Vector2(dx, dz).length() > PREVIEW_RADIUS and not required.has(row.id):
            continue
        var chunk_path: String = str(pristine_forward_map.get(str(row.scene), str(row.scene)))
        var chunk: Node = ResourceLoader.load(chunk_path, "", ResourceLoader.CACHE_MODE_REPLACE).instantiate()
        for piece in chunk.get_children():
            var parent := land.get_node_or_null(str(piece.get_meta("stream_parent")))
            if parent == null or piece.get_child_count() == 0: continue
            var unit := piece.get_child(0)
            piece.remove_child(unit)
            clear_owners(unit)
            parent.add_child(unit)
        chunk.free()
        loaded += 1
    return loaded

func clear_owners(node: Node) -> void:
    node.owner = null
    for child in node.get_children():
        clear_owners(child)

func show_patch(target: Vector3, landed: Dictionary) -> void:
    var camera := Camera3D.new()
    land.add_child(camera)
    camera.fov = 30.5
    camera.near = 0.036
    camera.far = 700.0
    var landing: Vector3 = target if landed.is_empty() else landed.position
    camera.position = landing + Vector3(0.0, 7.491446, 26.035766)
    camera.rotation_degrees = Vector3(-14.0, 0.0, 0.0)
    camera.make_current()
    attach_walker(camera, landed)
    overlay_box(landing + Vector3.UP, Vector3(0.35, 2.0, 0.35), Color(1.0, 0.45, 0.15, 1.0))

func attach_walker(camera: Camera3D, ground: Dictionary) -> void:
    var hud := CanvasLayer.new()
    root.add_child(hud)
    var hint := Label.new()
    hint.position = Vector2(16.0, 12.0)
    hud.add_child(hint)
    if ground.is_empty():
        hint.text = "No ground at the test point · Esc to close"
        physics_frame.connect(func():
            if Input.is_physical_key_pressed(KEY_ESCAPE): quit()
        )
        return

    var body := make_walker(ground.position)
    var start := body.global_position
    physics_frame.connect(func():
        if Input.is_physical_key_pressed(KEY_ESCAPE):
            quit()
            return
        if Input.is_physical_key_pressed(KEY_R) or body.global_position.y < PATCH_RAY_BOTTOM - 5.0:
            body.global_position = start
            body.velocity = Vector3.ZERO
        var x := int(Input.is_physical_key_pressed(KEY_D)) - int(Input.is_physical_key_pressed(KEY_A))
        var z := int(Input.is_physical_key_pressed(KEY_S)) - int(Input.is_physical_key_pressed(KEY_W))
        var move := Vector3(x, 0.0, z).normalized() * 6.0
        move_walker(body, move)
        camera.global_position = body.global_position + Vector3(0.0, 7.491446, 26.035766)
        hint.text = "WASD · R reset · Esc close     %s m" % str(xyz(body.global_position))
    )

func make_walker(at: Vector3) -> CharacterBody3D:
    var body := CharacterBody3D.new()
    body.collision_layer = 2
    body.collision_mask = 1
    body.floor_snap_length = 0.6
    var collider := CollisionShape3D.new()
    var capsule := CapsuleShape3D.new()
    capsule.radius = 0.4
    capsule.height = 1.6
    collider.shape = capsule
    collider.position.y = 0.8
    body.add_child(collider)
    land.add_child(body)
    body.global_position = at + Vector3.UP * 0.15
    return body

func move_walker(body: CharacterBody3D, move: Vector3) -> void:
    var delta := body.get_physics_process_delta_time()
    var stepped: bool = STEP_MOTION.try_step(body, move * delta)
    var fall := 0.0 if body.is_on_floor() else body.velocity.y - 24.0 * delta
    body.velocity = Vector3.ZERO if stepped else Vector3(move.x, fall, move.z)
    body.move_and_slide()

func overlay_box(at: Vector3, size: Vector3, color: Color) -> void:
    var box := BoxMesh.new()
    box.size = size
    var paint := StandardMaterial3D.new()
    paint.albedo_color = color
    paint.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    paint.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
    var instance := MeshInstance3D.new()
    instance.mesh = box
    instance.material_override = paint
    land.add_child(instance)
    instance.global_position = at
