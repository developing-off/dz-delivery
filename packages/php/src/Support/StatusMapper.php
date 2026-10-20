<?php

declare(strict_types=1);

namespace DzDelivery\Support;

use DzDelivery\Models\ParcelStatus;

/**
 * Native → unified status tables (docs/PROVIDERS.md). Matching is case-, accent-
 * and separator-insensitive, so `commande_recue`, `OrderReceived` and
 * `Commande reçue` are handled alike. Unknown values map to `unknown`, never throw.
 */
final class StatusMapper
{
    private const ZREXPRESS_EXACT = [
        'commanderecue' => ParcelStatus::PENDING,
        'orderreceived' => ParcelStatus::PENDING,
        'pretaexpedier' => ParcelStatus::CREATED,
        'readytodispatch' => ParcelStatus::CREATED,
        'confirmeaubureau' => ParcelStatus::IN_TRANSIT,
        'delivered' => ParcelStatus::DELIVERED,
        'livre' => ParcelStatus::DELIVERED,
        'livree' => ParcelStatus::DELIVERED,
        'encaisse' => ParcelStatus::DELIVERED,
        'cancelled' => ParcelStatus::CANCELLED,
        'canceled' => ParcelStatus::CANCELLED,
        'annule' => ParcelStatus::CANCELLED,
        'annulee' => ParcelStatus::CANCELLED,
        'deleted' => ParcelStatus::CANCELLED,
        'supprime' => ParcelStatus::CANCELLED,
        'supprimee' => ParcelStatus::CANCELLED,
    ];

    private const ZREXPRESS_RETURNED_PREFIXES = ['returned', 'return', 'retour', 'retourne'];

    private const ZREXPRESS_IN_TRANSIT_KEYWORDS = [
        'outfordelivery', 'enlivraison', 'sortieenlivraison', 'transit', 'hub', 'transfer',
        'dispatched', 'expedie', 'pickedup', 'ramasse', 'shipped', 'center', 'centre',
        'attempt', 'tentative', 'echec', 'failed', 'postponed', 'reporte', 'enattente',
        'awaiting', 'pickup', 'station', 'wilaya',
    ];

    private const YALIDINE_EXACT = [
        'enpreparation' => ParcelStatus::PENDING,
        'averifier' => ParcelStatus::PENDING,
        'pasencoreexpedie' => ParcelStatus::CREATED,
        'pasencoreramasse' => ParcelStatus::CREATED,
        'pretaexpedier' => ParcelStatus::CREATED,
        'enpassation' => ParcelStatus::CREATED,
        'livre' => ParcelStatus::DELIVERED,
        'annule' => ParcelStatus::CANCELLED,
        'supprime' => ParcelStatus::CANCELLED,
        'echangeechoue' => ParcelStatus::RETURNED,
        'colisabandonne' => ParcelStatus::RETURNED,
    ];

    private const YALIDINE_IN_TRANSIT = [
        'ramasse', 'expedie', 'centre', 'enlocalisation', 'entransit', 'versstation', 'enstation', 'verswilaya', 'recuawilaya',
        'transfert', 'enattentedetransfert', 'pretpourlivreur', 'dispatche', 'sortienlivraison',
        'sortieenlivraison', 'enattentduclient', 'enattenteduclient', 'enattente',
        'tentativeechouee', 'echeclivraison', 'echecdelivraison', 'enalerte', 'alerteresolue',
        'bloque', 'debloque', 'enlivraison',
    ];

    /** Maystro numeric status code → native status name ("Status Code REF"). */
    public const MAYSTRO_STATUS_CODES = [
        4 => 'CREATED',
        5 => 'PICK_UP_REQUESTED',
        6 => 'IN_PROCESS',
        8 => 'WAITING_TRANSIT',
        9 => 'IN_TRANSIT_TO_BE_SHIPPED',
        10 => 'IN_TRANSIT_TO_BE_RETURNED',
        11 => 'PENDING',
        12 => 'OUT_OF_STOCK',
        15 => 'READY_TO_SHIP',
        22 => 'ASSIGNED',
        31 => 'SHIPPED',
        32 => 'ALERTED',
        41 => 'DELIVERED',
        42 => 'POSTPONED',
        50 => 'ABORTED',
        51 => 'READY_TO_RETURN',
        52 => 'TAKEN_BY_STORE',
        53 => 'NOT_RECEIVED',
    ];

    private const MAYSTRO_EXACT = [
        'created' => ParcelStatus::PENDING,
        'pending' => ParcelStatus::PENDING,
        'outofstock' => ParcelStatus::PENDING,
        'pickuprequested' => ParcelStatus::CREATED,
        'inprocess' => ParcelStatus::CREATED,
        'waitingtransit' => ParcelStatus::IN_TRANSIT,
        'intransittobeshipped' => ParcelStatus::IN_TRANSIT,
        'readytoship' => ParcelStatus::IN_TRANSIT,
        'assigned' => ParcelStatus::IN_TRANSIT,
        'shipped' => ParcelStatus::IN_TRANSIT,
        'alerted' => ParcelStatus::IN_TRANSIT,
        'postponed' => ParcelStatus::IN_TRANSIT,
        'delivered' => ParcelStatus::DELIVERED,
        'aborted' => ParcelStatus::CANCELLED,
        'cancelled' => ParcelStatus::CANCELLED,
        'canceled' => ParcelStatus::CANCELLED,
        'intransittobereturned' => ParcelStatus::RETURNED,
        'readytoreturn' => ParcelStatus::RETURNED,
        'readytobereturned' => ParcelStatus::RETURNED,
        'takenbystore' => ParcelStatus::RETURNED,
        'notreceived' => ParcelStatus::RETURNED,
    ];

    /** Ecotrack activity keys + order status enum keys (normalized). French labels are not mapped. */
    private const ECOTRACK_EXACT = [
        'orderinformationreceivedbycarrier' => ParcelStatus::CREATED,
        'picked' => ParcelStatus::IN_TRANSIT,
        'acceptedbycarrier' => ParcelStatus::IN_TRANSIT,
        'dispatchedtodriver' => ParcelStatus::IN_TRANSIT,
        'attemptdelivery' => ParcelStatus::IN_TRANSIT,
        'livred' => ParcelStatus::DELIVERED,
        'encaissed' => ParcelStatus::DELIVERED,
        'payed' => ParcelStatus::DELIVERED,
        'returnasked' => ParcelStatus::RETURNED,
        'returnintransit' => ParcelStatus::RETURNED,
        'returnreceived' => ParcelStatus::RETURNED,
        'preteaexpedier' => ParcelStatus::PENDING,
        'preteapreparer' => ParcelStatus::PENDING,
        'enpreparationstock' => ParcelStatus::CREATED,
        'enramassage' => ParcelStatus::CREATED,
        'vershub' => ParcelStatus::IN_TRANSIT,
        'enhub' => ParcelStatus::IN_TRANSIT,
        'verswilaya' => ParcelStatus::IN_TRANSIT,
        'enpreparation' => ParcelStatus::IN_TRANSIT,
        'enlivraison' => ParcelStatus::IN_TRANSIT,
        'suspendu' => ParcelStatus::IN_TRANSIT,
        'livrenonencaisse' => ParcelStatus::DELIVERED,
        'encaissenonpaye' => ParcelStatus::DELIVERED,
        'paiementsprets' => ParcelStatus::DELIVERED,
        'payeetarchive' => ParcelStatus::DELIVERED,
        'retourchezlivreur' => ParcelStatus::RETURNED,
        'retourtransitentrepot' => ParcelStatus::RETURNED,
        'retourentraitement' => ParcelStatus::RETURNED,
        'retourrecu' => ParcelStatus::RETURNED,
        'retourarchive' => ParcelStatus::RETURNED,
        'annule' => ParcelStatus::CANCELLED,
    ];

    public static function zrexpress(?string $native): string
    {
        $key = Text::key((string) $native);
        if ($key === '') {
            return ParcelStatus::UNKNOWN;
        }
        if (isset(self::ZREXPRESS_EXACT[$key])) {
            return self::ZREXPRESS_EXACT[$key];
        }
        foreach (self::ZREXPRESS_RETURNED_PREFIXES as $prefix) {
            if (str_starts_with($key, $prefix)) {
                return ParcelStatus::RETURNED;
            }
        }
        foreach (self::ZREXPRESS_IN_TRANSIT_KEYWORDS as $keyword) {
            if (str_contains($key, $keyword)) {
                return ParcelStatus::IN_TRANSIT;
            }
        }

        return ParcelStatus::UNKNOWN;
    }

    public static function yalidine(?string $native): string
    {
        $key = Text::key((string) $native);
        if ($key === '') {
            return ParcelStatus::UNKNOWN;
        }
        if (isset(self::YALIDINE_EXACT[$key])) {
            return self::YALIDINE_EXACT[$key];
        }
        if (str_starts_with($key, 'retour')) {
            return ParcelStatus::RETURNED;
        }
        if (in_array($key, self::YALIDINE_IN_TRANSIT, true)) {
            return ParcelStatus::IN_TRANSIT;
        }

        return ParcelStatus::UNKNOWN;
    }

    /**
     * Maystro status code (`41`, `"41"`) or name (`"DELIVERED"`) → unified status.
     * Meant for webhook payloads (`payload.status`).
     */
    public static function maystro(string|int|null $native): string
    {
        $value = trim((string) $native);
        if (ctype_digit($value)) {
            $value = self::MAYSTRO_STATUS_CODES[(int) $value] ?? '';
        }

        return self::MAYSTRO_EXACT[Text::key($value)] ?? ParcelStatus::UNKNOWN;
    }

    /**
     * Ecotrack activity key (`livred`, `Return_received`, ...) or order status enum key
     * (`en_livraison`, `annule`, ...) → unified status. `notification_on_order` is a remark,
     * not a status, and maps to `unknown`.
     */
    public static function ecotrack(?string $native): string
    {
        return self::ECOTRACK_EXACT[Text::key((string) $native)] ?? ParcelStatus::UNKNOWN;
    }

    public static function map(string $provider, ?string $native): string
    {
        return match ($provider) {
            'zrexpress' => self::zrexpress($native),
            'yalidine' => self::yalidine($native),
            'maystro' => self::maystro($native),
            'ecotrack' => self::ecotrack($native),
            default => ParcelStatus::UNKNOWN,
        };
    }
}
