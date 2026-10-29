# SnapShare Scaling Plan

SnapShare is a photo-sharing app where users upload photos and scroll a feed of photos from people they follow.

## 1. Assumptions

- 10 million registered users
- 10% of users are active each day
- Each active user uploads 1 photo per day
- Each active user views 50 feed pages per day
- An average photo is 2 MB
- Each photo also gets a 50 KB thumbnail
- Peak traffic is 5 times the average
- There are 86,400 seconds in a day
- Storage figures use decimal units (1 TB = 1,000,000 MB)

**Daily active users:** 10,000,000 x 10% = **1,000,000 users per day**

## 2. Estimates

### Uploads per second
- Uploads per day: 1,000,000 users x 1 photo = 1,000,000 uploads
- Average: 1,000,000 / 86,400 = about **12 uploads per second**
- Peak (5x): about **58 uploads per second**

### Feed views per second
- Feed views per day: 1,000,000 users x 50 pages = 50,000,000 views
- Average: 50,000,000 / 86,400 = about **579 views per second**
- Peak (5x): about **2,900 views per second**

### Photo storage per year
- Storage per upload: 2 MB photo + 0.05 MB thumbnail = 2.05 MB
- Per day: 1,000,000 x 2.05 MB = 2.05 TB
- Per year: 2.05 TB x 365 = about **748 TB** (roughly 0.75 PB)
  - Original photos: about 730 TB
  - Thumbnails: about 18 TB

## 3. Read-heavy or write-heavy?

SnapShare is **read-heavy**. There are about 579 feed views per second against only 12 uploads per second, a ratio of roughly **50 reads for every 1 write**.

What this means for the design:
- Most effort goes into making reads fast and cheap: caching, a CDN, and a read replica so the main database is not overloaded.
- Writes can be slower and handled in the background, for example creating thumbnails with a queue.
- Because the same popular photos and feeds are requested over and over, caching is very effective.

## 4. Why photos should not be stored in the database

Photos are large files (2 MB each, hundreds of terabytes per year). If they lived inside the database:
- The database would grow huge, making backups, restores and replication slow and expensive.
- Every feed view would push large files through the database connection, using up the bandwidth and memory it needs for fast queries.
- Database storage costs far more per gigabyte than file storage.
- Photos could not be served from a CDN close to users.

Instead, photo files go into **object storage**, which is cheap, scales almost without limit, and serves files directly. The database only stores a small record per photo: its id, owner, caption, time and the **URL** of the file in object storage.

## 5. Architecture diagram

```
                         +---------+
                         |  Users  |
                         +----+----+
                              |
             +----------------+----------------+
             | photos (reads)                  | API requests
             v                                 v
        +---------+                    +---------------+
        |   CDN   |                    | Load Balancer |
        +----+----+                    +-------+-------+
             |  (cache miss)                   |
             v                         +-------+-------+
   +------------------+                |               |
   |  Object Storage  |           +----v----+     +----v----+
   |  (photos and     |           |  App    | ... |  App    |
   |   thumbnails)    |           | Server  |     | Server  |
   +--------^---------+           +----+----+     +----+----+
            |                          |               |
            |                          +-------+-------+
            |                                  |
            |            +---------------------+--------------------+
            |            |                     |                    |
            |       +----v----+      +---------v--------+     +-----v-----+
            |       |  Cache  |      |     Database     |     |   Queue   |
            |       | (feeds, |      |     (primary)    |     | (thumb-   |
            |       |  hot    |      +---------+--------+     |  nail     |
            |       |  data)  |                |              |  jobs)    |
            |       +---------+       replicates to           +-----+-----+
            |                                  |                    |
            |                         +--------v--------+           v
            |                         |  Read Replica   |     +-----------+
            |                         | (feed reads)    |     |  Worker   |
            |                         +-----------------+     | (makes    |
            |                                                 | thumbnails)|
            +-------------------------------------------------+-----------+
                        saves thumbnail to object storage
```

## 6. Components

- **CDN:** stores copies of photos and thumbnails at locations close to users, so images load quickly and most traffic never reaches our servers.
- **Load balancer:** spreads incoming requests across many app servers so no single server is overloaded and the app stays up if one fails.
- **App servers:** run the application logic (login, upload, feed) and can be added or removed as traffic changes.
- **Cache:** keeps frequently used data such as ready-made feeds in fast memory, so the database is asked far less often.
- **Database (primary):** stores users, follows and photo records (not the files) and handles all writes.
- **Read replica:** a copy of the database that answers feed read queries, taking load off the primary.
- **Object storage:** holds the photo and thumbnail files cheaply and reliably at very large scale.
- **Queue:** holds thumbnail jobs so the upload request can finish quickly instead of waiting for image processing.
- **Worker:** picks jobs from the queue, creates the 50 KB thumbnail and saves it, so heavy work runs in the background.

## 7. Upload flow, step by step

1. The user selects a photo in the app and taps upload.
2. The request goes through the **load balancer** to an **app server**.
3. The app server checks that the user is logged in and that the file is a valid image of an allowed size.
4. The app server saves the original photo file to **object storage**.
5. The app server writes a record to the **database** (photo id, owner, time, file URL, thumbnail status "pending").
6. The app server puts a "create thumbnail" job on the **queue**.
7. The app server replies to the user straight away with "upload successful". The user does not wait for the thumbnail.
8. A **worker** takes the job from the queue, downloads the original photo, and creates a 50 KB thumbnail.
9. The worker saves the thumbnail to object storage and updates the photo record to mark the thumbnail "ready". If the job fails, it is retried.
10. When followers load their feeds, the thumbnail is served through the **CDN**, and the relevant cached feeds are refreshed or expire.

## 8. Trade-offs

- **Speed vs freshness (cache and read replica):** caches and replicas make feeds fast, but the data can be slightly out of date. A new photo might take a few seconds to appear in a follower's feed. This is acceptable for a photo feed, but would not be for something like a bank balance.
- **Fast uploads vs instant thumbnails (queue):** using a queue makes uploads feel instant, but the thumbnail is not ready the moment the photo is uploaded. We may need to show a placeholder briefly, and we need to run and monitor the extra queue and workers.
- **Cost vs performance (CDN and storage):** a CDN gives users fast image loading but adds ongoing cost, and keeping 748 TB per year of photos is expensive. We could reduce cost by moving old photos to cheaper storage, at the price of slower access to them.
- **Complexity vs simplicity:** splitting the system into many components lets it scale and survive failures, but it is harder to build, run and debug than one server and one database.