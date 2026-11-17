# R06: отдельное локальное тестовое окружение Onay

Это **тестовый** инструмент существующего приложения. Он создаёт только новую
БД `onay_r06_<16–32 hex>`, применяет настоящие 18 миграций и готовит отдельные
учётные записи пассажира, администратора и трёх водителей. Машины подаются на
проверку и одобряются через существующий административный API. Маршрут имеет
остановки A/C/B и направления A→B/B→A. Сценарий не меняет FIFO, геозоны,
резервирование, распределение заказов или реальные тарифы.

Режим: `NODE_ENV=test`, настоящий PostgreSQL adapter, development OTP,
`TEZJET_SMS_SEND_ENABLED=false`, обязательное одобрение водителей. API harness
использует реальные app/store/Socket.IO, слушает **только 127.0.0.1**, запускается
на время проверки и останавливается после неё. Телефоны, коды, токены и URL БД
не выводятся. Это не production-сервер, не SMS-проверка и не подтверждение работы
физических телефонов, сети или карты. Координаты — явно синтетические fixtures.

## Фактическое состояние при подготовке

В Cloud-среде локальный запуск PostgreSQL заблокирован нехваткой диска Docker
VFS. Контейнер R06 не был создан; попытки не повторяются. Проверены только
защитные условия на Node 24; полный Node 22/PG/lifecycle/restart результат должен
дать существующий CI после независимого review. Не трактовать наличие кода или
этой инструкции как выполненный PostgreSQL smoke. Владелец ещё не утвердил цену
для физической beta. Число `12000` ниже — **существующий синтетический тариф из
`route-orders.test.mjs`**, исключительно для автоматических тестов.

## Предварительные условия WSL/Linux

Нужны существующий checkout ветки PR #110, Node 22, зафиксированные зависимости
API/DB и отдельный локальный PostgreSQL 16 с правом создавать тестовые БД.
Зависимости устанавливаются по существующему frozen lockfile, без обновления
пакетов; CI уже делает такую установку. В текущей Cloud-сессии новые установки
и новые Docker-контейнеры запрещены из-за диска. Эти команды — инструкция для
отдельного проверяемого локального окружения, не заявление о запуске в WSL.

Оператор должен заранее выбрать **только тестовый** PostgreSQL на loopback.
Его приватный env-файл с `DATABASE_URL` должен быть вне репозитория и иметь
права 600. Не использовать production URL, реальные аккаунты или реальные
данные. Не включать shell tracing, не печатать env-файл и не прикладывать его
к отчётам. Инструмент отвергает внешние хосты, query/host overrides, другие
имена БД и любую уже существующую целевую БД до миграции.

```sh
set +x
# ONAY_R06_TEST_ADMIN_ENV задаётся оператором: путь к приватному test-only env.
. "$ONAY_R06_TEST_ADMIN_ENV"
export DATABASE_URL
export ONAY_R06_PRIVATE_ROOT="$HOME/.local/state/onay-r06"
mkdir -p "$ONAY_R06_PRIVATE_ROOT"
chmod 700 "$ONAY_R06_PRIVATE_ROOT"
# Каталог этого запуска должен быть новым и находиться вне checkout.
export ONAY_R06_RUN_DIRECTORY="$ONAY_R06_PRIVATE_ROOT/run-1"
onay_r06_database="$(node -e "process.stdout.write('onay_r06_' + require('node:crypto').randomBytes(12).toString('hex'))")"
node deploy/onay/test-environment.mjs prepare \
  --ack=ONAY_R06_TEST_ONLY --admin-env=DATABASE_URL \
  --database="$onay_r06_database" --run-directory="$ONAY_R06_RUN_DIRECTORY" \
  --test-price-per-stop=12000
node deploy/onay/test-environment.mjs exercise \
  --run-directory="$ONAY_R06_RUN_DIRECTORY"
node deploy/onay/test-environment.mjs probe \
  --run-directory="$ONAY_R06_RUN_DIRECTORY"
```

Цена обязательна: нет значения по умолчанию, пересчёта KZT или подразумеваемого
одобрения владельца. Для этого теста допустим явно обозначенный синтетический
fixture. Реальная цена и дальнейший физический запуск остаются отдельным
условием приёмки.

`prepare` применяет миграции в новой БД, сверяет 18 hash-записей journal,
повторяет миграцию без изменений и проверяет отсутствие заказа без водителя.
Он создаёт приватный `environment.private.json` с правами 600. В нём остаются
синтетические учётные записи, токены и DB URL; файл не публиковать и не копировать
в Git. В нём нет отправленной SMS или внешнего API-ключа.

`exercise` проверяет настоящий HTTP-цикл: более ранний водитель встречного
направления не перехватывает FIFO; повтор с booking key не резервирует места
снова; reject сохраняет поиск, возвращает места один раз и передаёт offer
следующему eligible водителю. Далее идут accept, arrival, board, перезапуск
отдельного API-процесса с живой бронью, depart и complete. Повторы accept/board,
повтор depart и повтор complete проверяются по существующему контракту. После
перезапуска сохраняются сессии, enrollment и бронь; после завершения — ровно
один заказ, frozen UZS fare и возврат мест ровно один раз. Exercise выполняется
один раз на свежей fixture; повторный прогон готовится в новой БД.

`probe` ничего не бронирует: читает **точный** завершённый order/request key из
приватной fixture, проверяет историю, места, одобренную ревизию машины и сохранённое
направление. Он не выдаёт наличие произвольного старого заказа за результат R06.
API restart и PostgreSQL restart — разные проверки. `postgresRestartObserved`
становится true только при изменении SQL `pg_postmaster_start_time()` относительно
подготовки. После перезапуска только своего тестового PostgreSQL можно потребовать
это условие через `--require-postgres-restart=true`; неизменившееся время завершает
проверку ошибкой. Сам CLI не перезапускает Docker и не выбирает чужой контейнер.

## Проверка в существующем CI

Изменён только job `verify` существующего `.github/workflows/ci.yml`. Его
PostgreSQL service и Node 22 уже были настроены. Существующие typecheck, API tests
и bounded queue load сохранены. После API tests добавлены четыре шага:

1. Подготовка новой isolated БД и real-HTTP exercise с синтетическими 12000 UZS.
2. Перезапуск **только** 64-hex ID `${{ job.services.postgres.id }}` этого job,
   ограниченное ожидание `pg_isready`, probe с обязательным изменением start time.
3. `always()` cleanup только БД с подтверждённым private ownership marker.
4. Загрузка трёх разрешённых безопасных receipt-файлов по точным именам.

Новых CI jobs, PostgreSQL services, APK builds, deployments или внешних
уведомлений нет. Этот CI patch ещё требует review и реального исполнения.

Локальные проверки кода без БД:

```sh
node deploy/onay/test-environment-guards.test.mjs
node --check deploy/onay/test-environment.mjs
node --check deploy/onay/test-fixture.mjs
```

Новый `artifacts/api-server/test/local-test-environment.test.mjs` входит в
существующий API test glob. Его integration case требует настоящую локальную
БД, создаёт новую отдельную БД, применяет 18 миграций и выполняет HTTP workflow.
Отсутствие БД — FAIL/BLOCKED, не skip и не успешная имитация.

## Отчёты и очистка

Разрешено передавать только `receipt.json`, `lifecycle-receipt.json` и
`retained-state-receipt.json`. Они содержат статусы, счётчики, synthetic-price
label и SHA bundle; без OTP, телефонов, токенов, DB URL или raw payloads. Никогда
не загружать весь приватный каталог, `environment.private.json`, env-файлы или
серверные дампы. CI использует allowlist трёх конкретных имён, без wildcard.

После завершения всех проверок и остановки пользователей этой fixture:

```sh
node deploy/onay/test-environment.mjs destroy \
  --run-directory="$ONAY_R06_RUN_DIRECTORY" --ack=DROP_OWNED_R06_TEST_DATABASE
```

Удаление требует явного acknowledgment, правильного localhost/prefix, приватного
файла и совпадения случайных run ID/ownership proof внутри именно этой БД. Другие
БД, volumes, контейнеры и файлы не удаляются. Приватный каталог CLI намеренно не
удаляет: оператор разбирает его отдельно после проверки происхождения. Секреты
не включать в checkpoints; в checkpoint сохранять только путь к приватному
локальному конфигу и безопасные receipts.
